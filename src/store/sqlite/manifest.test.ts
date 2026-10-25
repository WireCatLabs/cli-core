import { spawn } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { MIGRATIONS, migrate } from "../migrations.js"
import { openCache } from "../open.js"
import { generatedMigrations, MANIFEST } from "./manifest.js"
import { GENERATED } from "./migrations.generated.js"

const DRIZZLE = join(import.meta.dirname, "../../../drizzle")
const fresh = () => join(mkdtempSync(join(tmpdir(), "manifest-")), "messages.db")

/** What would break a build already installed: a rebuilt or renamed base table, a column it cannot fill. */
const rebuilds = (statement: string): boolean =>
  /\bDROP\s+TABLE\b/i.test(statement) ||
  /\bALTER\s+TABLE\b[^;]*\bRENAME\b/i.test(statement) ||
  /`__new_/.test(statement) ||
  (/\bADD\s+(COLUMN\s+)?\S+[^;]*\bNOT\s+NULL\b/i.test(statement) && !/\bDEFAULT\b/i.test(statement))

describe("the generated migrations", () => {
  it("**are bundled exactly as drizzle-kit wrote them** — run pnpm db:bundle when this fails", () => {
    const folders = readdirSync(DRIZZLE, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    const onDisk = folders.map((name) => ({
      name,
      statements: readFileSync(join(DRIZZLE, name, "migration.sql"), "utf8")
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter(Boolean),
    }))

    expect(GENERATED).toEqual(onDisk)
  })

  it("each have one manifest row, in order, numbered from 1 without a gap", () => {
    expect(MANIFEST.map(({ name }) => name)).toEqual(GENERATED.map(({ name }) => name))
    const versions = [...new Set(MANIFEST.map(({ version }) => version))]
    expect(versions).toEqual(versions.map((_, index) => 1 + index))
    for (const entry of MANIFEST) expect(entry.minCompatible).toBeLessThanOrEqual(entry.version)
    expect(MIGRATIONS.map(({ version }) => version)).toEqual(MIGRATIONS.map((_, index) => 1 + index))
  })

  it("**never rebuild a base table** or add a column an older build cannot fill", () => {
    // A version that raises minCompatible to itself locks every older build out, so it may drop.
    for (const { version, minCompatible, statements } of generatedMigrations()) {
      if (minCompatible === version) continue
      for (const statement of statements) expect(rebuilds(statement), statement).toBe(false)
    }
  })

  it("would catch what drizzle-kit writes for a constraint change", () => {
    expect(rebuilds("CREATE TABLE `__new_chats` (`pk` integer PRIMARY KEY)")).toBe(true)
    expect(rebuilds("DROP TABLE `chats`;")).toBe(true)
    expect(rebuilds("ALTER TABLE `__new_chats` RENAME TO `chats`;")).toBe(true)
    expect(rebuilds("ALTER TABLE `chats` ADD `folder` text NOT NULL;")).toBe(true)
    expect(rebuilds("ALTER TABLE `chats` ADD `folder` text DEFAULT '' NOT NULL;")).toBe(false)
    expect(rebuilds("ALTER TABLE `chats` ADD `folder` text;")).toBe(false)
  })

  it("applies the folders of one version as one migration, and refuses them disagreeing", () => {
    const generated = [
      { name: "a", statements: ["SELECT 1"] },
      { name: "b", statements: ["SELECT 2"] },
    ]
    expect(
      generatedMigrations(
        [
          { name: "a", version: 6, minCompatible: 6 },
          { name: "b", version: 6, minCompatible: 6 },
        ],
        generated,
      ),
    ).toEqual([{ version: 6, minCompatible: 6, statements: ["SELECT 1", "SELECT 2"] }])
    expect(() =>
      generatedMigrations(
        [
          { name: "a", version: 6, minCompatible: 6 },
          { name: "b", version: 6, minCompatible: 1 },
        ],
        generated,
      ),
    ).toThrow(/disagree/)
  })

  it("never lowers or silently defaults an activated compatibility gate", () => {
    const generated = [
      { name: "a", statements: ["SELECT 1"] },
      { name: "b", statements: ["SELECT 2"] },
    ]
    const first = { name: "a", version: 25, minCompatible: 25 }
    for (const minCompatible of [undefined, 0, 1, 24, NaN, 27])
      expect(() =>
        generatedMigrations([first, { name: "b", version: 26, minCompatible } as (typeof MANIFEST)[number]], generated),
      ).toThrow(/minCompatible/)
    expect(
      generatedMigrations([first, { name: "b", version: 26, minCompatible: 25 }], generated).at(-1)?.minCompatible,
    ).toBe(25)
  })

  it("refuses a manifest row with no bundled migration, and numbers the rest", () => {
    const generated = [{ name: "b", statements: ["SELECT 1"] }]
    expect(generatedMigrations([{ name: "b", version: 6, minCompatible: 6 }], generated)).toEqual([
      { version: 6, minCompatible: 6, statements: ["SELECT 1"] },
    ])
    expect(() => generatedMigrations([{ name: "missing", version: 6, minCompatible: 1 }], generated)).toThrow(
      /pnpm db:bundle/,
    )
  })
})

const OPENER = `
import { registerHooks } from "node:module"
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (specifier.startsWith(".") && specifier.endsWith(".js")) return next(specifier.slice(0, -3) + ".ts", context)
      throw error
    }
  },
})
const [path, migrations] = process.argv.slice(1)
const { openCache } = await import(${JSON.stringify(join(import.meta.dirname, "../open.ts"))})
const { MIGRATIONS, migrate } = await import(${JSON.stringify(join(import.meta.dirname, "../migrations.ts"))})
const database = await openCache(path)
migrate(database, { migrations: [...MIGRATIONS, ...JSON.parse(migrations)] })
database.close()
`

const opener = (path: string, migrations: unknown) =>
  new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", OPENER, path, JSON.stringify(migrations)], {
      stdio: ["ignore", "ignore", "inherit"],
    })
    child.on("exit", resolve)
  })

describe("two processes opening one file", () => {
  it("**apply a migration once**: the second waits for the first, then finds it done", async () => {
    const path = fresh()
    const database = await openCache(path)
    migrate(database)
    database.close()
    const next = {
      version: (MIGRATIONS.at(-1)?.version ?? 0) + 1,
      minCompatible: 1,
      statements: [
        "CREATE TABLE applied (n INTEGER)",
        // Long enough that the two openers overlap: the second must wait on the first's write lock.
        "INSERT INTO applied (n) WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c LIMIT 300000) SELECT n FROM c",
      ],
    }

    expect(await Promise.all([opener(path, [next]), opener(path, [next])])).toEqual([0, 0])

    const after = await openCache(path)
    expect(after.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version = ?").get(next.version)).toEqual({
      n: 1,
    })
    expect(after.prepare("SELECT count(*) AS n FROM applied").get()).toEqual({ n: 300000 })
    after.close()
  }, 20_000)
})
