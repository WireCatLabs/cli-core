import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Command } from "commander"
import * as v from "valibot"
import { afterEach, describe, expect, it } from "vitest"
import { answerEntitySchema } from "../../cli/answer-entity.js"
import { provide } from "../../cli/context.js"
import { isOwnerOnlyStoreSetting, storeSettingsOf } from "../../cli/store-settings.js"
import { CRM_OPENS } from "../../domain/providers.js"
import type { AppIdentity } from "../../ports/app.js"
import type { Level } from "../../sends/permissions.js"
import { searchAll } from "../../services/search-all.js"
import { openCache } from "../../store/open.js"
import { crmSettingKey, parseCrmSettingValue, saveCrmSetting } from "../../store/sqlite/crm-settings.js"
import { type MessageStore, openStore } from "../../store/store.js"
import { DAILY_FOREIGN_CONTACTS, foreignContactsPathFor } from "../foreign-contacts.js"
import {
  exampleDeal,
  FAKE_FILE_TOKEN,
  type FakeCrmFile,
  type FakeCrmSourceOptions,
  fakeCrmSource,
} from "../testing/index.js"
import { syncFiles } from "./files.js"
import { addCrmCommands, type CrmRun } from "./index.js"

const APP: AppIdentity = {
  command: "crm",
  appName: "example-crm-cli",
  envPrefix: "CRM",
  description: "synthetic",
  version: "1.0.0",
}
const PORTAL = { provider: "example-crm", account: "portal" }
const NOW = Date.UTC(2026, 10, 16, 12)
const DAY = 24 * 60 * 60 * 1000
const MB = 1024 * 1024

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const commandAt = (root: Command, argv: readonly string[]): Command => {
  let at = root
  for (const word of argv) {
    const next = at.commands.find((one) => one.name() === word)
    if (!next) break
    at = next
  }
  return at
}

const file = (owner: string, id: string, extra: Partial<FakeCrmFile> = {}): FakeCrmFile => ({
  owner: { kind: "deal", id: owner },
  id,
  name: `${id}.txt`,
  bytes: `Supply contract ${id} for the example kitchen`,
  mime: "text/plain",
  created: NOW - DAY,
  ...extra,
})

interface Setup {
  fake?: FakeCrmSourceOptions
  files?: FakeCrmFile[]
  permissions?: Record<string, Level>
  user?: string | null
  now?: () => number
}

const setup = async ({ fake = {}, files = [], permissions = {}, user = "7", now = () => NOW }: Setup = {}) => {
  const path = join(mkdtempSync(join(tmpdir(), "crm-files-")), "store.db")
  const store = await openStore({ path })
  opened.push(store)
  await store.accounts.registerProvider({
    name: "example-crm",
    kind: "crm",
    aliases: [],
    command: "crm",
    opens: CRM_OPENS,
  })
  const source = fakeCrmSource({ self: "7", admin: false, files, ...fake })
  source.put("deal", exampleDeal("d1", { assignee: "7", updatedAt: NOW - DAY }))
  source.put("deal", exampleDeal("d2", { assignee: "9", updatedAt: NOW - DAY }))
  source.put("deal", exampleDeal("d3", { assignee: "7", updatedAt: NOW - 30 * DAY }))
  const home = mkdtempSync(join(tmpdir(), "crm-files-home-"))
  const env = { HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home, CRM_STATE_DIR: home }
  const run: CrmRun = { profile: "work", user, account: PORTAL, store, source: () => source, env }
  let data = ""
  let root = new Command("crm")
  const printed = async (args: string[]) => {
    root = new Command("crm")
      .exitOverride()
      .configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
      .option("--json")
      .option("--fields <paths>")
      .option("--offline")
    addCrmCommands(root, { app: APP, open: async () => run, files: true, now })
    provide(root, {
      streams: { data: (text: string) => (data += text), diagnostic: () => undefined },
      tty: false,
      resolveSettings: () => ({ profile: "work", permissions }),
    } as never)
    data = ""
    await root.parseAsync(args, { from: "user" })
    return data
  }
  const cli = async (...args: string[]) => {
    await printed([...args, "--json"])
    const envelope = JSON.parse(data) as Record<string, unknown> & { item?: unknown; items?: unknown[] }
    const schema = answerEntitySchema(commandAt(root, args))
    if (schema)
      for (const item of envelope.items ?? [envelope.item]) {
        const parsed = v.safeParse(schema, item)
        if (!parsed.success) throw new Error(`${args.join(" ")}: ${parsed.issues.map((one) => one.message).join("; ")}`)
      }
    return envelope as Record<string, unknown> & { item: Record<string, unknown>; items: Record<string, unknown>[] }
  }
  const settings = async (values: Record<string, number>) => {
    const database = await openCache(path)
    for (const [name, value] of Object.entries(values))
      saveCrmSetting(database, crmSettingKey(PORTAL, `files.${name}` as never), value, NOW)
    database.close()
  }
  // The whole copy, every user's deals: a file's text follows its deal there (SEC-3).
  const wholeCopy = async () => {
    const database = await openCache(path)
    saveCrmSetting(database, crmSettingKey(PORTAL, "scope"), "all", NOW)
    database.close()
  }
  const folder = join(home, "crm", "files", "example-crm-portal")
  const quotaFile = () => foreignContactsPathFor(APP, PORTAL, env, "7")
  // The store runs in WAL mode: fresh rows sit in the -wal file until a checkpoint.
  const dump = () =>
    [path, `${path}-wal`]
      .filter((one) => existsSync(one))
      .map((one) => readFileSync(one, "latin1"))
      .join("")
  return { source, store, cli, run, settings, wholeCopy, folder, quotaFile, dump, home, path }
}

/** Every file below `root`, with its mode. */
const tree = (root: string): { path: string; mode: number }[] =>
  existsSync(root)
    ? readdirSync(root, { recursive: true, withFileTypes: true }).map((entry) => {
        const at = join(entry.parentPath, entry.name)
        return { path: at, mode: statSync(at).mode & 0o777 }
      })
    : []

describe("files list", () => {
  it("lists a record's files live, marks the downloaded ones, and never prints a link", async () => {
    const { cli } = await setup({ files: [file("d1", "f1"), file("d1", "f2", { size: null })] })
    await cli("files", "download", "deal:d1:record:f1")
    const listed = await cli("files", "list", "--deal", "d1")
    expect(listed.items.map((one) => [one.id, one.downloaded, one.size])).toEqual([
      ["deal:d1:record:f1", true, 42],
      ["deal:d1:record:f2", false, null],
    ])
    expect(JSON.stringify(listed)).not.toContain(FAKE_FILE_TOKEN)
  })

  it("says which kind of file a missing scope hides and answers incomplete", async () => {
    const { cli } = await setup({
      files: [file("d1", "f1")],
      fake: { fileGaps: [{ scope: "disk", message: "activity files need the disk scope" }] },
    })
    const listed = await cli("files", "list", "--deal", "d1")
    expect(listed.items).toHaveLength(1)
    expect(listed.meta).toMatchObject({
      complete: false,
      issues: [{ reason: "crm.scope-missing", source: "crm:files/disk" }],
    })
  })

  it("takes exactly one record, and a record the CRM does not have is not found", async () => {
    const { cli } = await setup()
    await expect(cli("files", "list")).rejects.toMatchObject({ details: { reason: "ref.malformed" } })
    await expect(cli("files", "list", "--deal", "d1", "--person", "p1")).rejects.toMatchObject({
      details: { reason: "ref.malformed" },
    })
    await expect(cli("files", "list", "--deal", "d404")).rejects.toMatchObject({ code: "not_found" })
  })
})

describe("the day's limit on colleagues' files (NEED-2703 B)", () => {
  it("spends one slot for a colleague's deal, listed and downloaded, none for an own one, and refuses the 101st", async () => {
    const { cli, quotaFile } = await setup({ files: [file("d1", "f1"), file("d2", "f2")] })
    await cli("files", "list", "--deal", "d1")
    await cli("files", "list", "--deal", "d2")
    await cli("files", "download", "deal:d2:record:f2")
    expect(JSON.parse(readFileSync(quotaFile(), "utf8")).seen).toEqual(["deal:d2"])
    writeFileSync(
      quotaFile(),
      JSON.stringify({ day: "2026-11-16", seen: Array.from({ length: DAILY_FOREIGN_CONTACTS }, (_, at) => `x:${at}`) }),
    )
    await expect(cli("files", "list", "--deal", "d2")).rejects.toMatchObject({
      details: { reason: "crm.foreign-contacts-spent" },
    })
    await cli("files", "list", "--deal", "d1")
  })

  it("lets the administrator read every record's files without counting", async () => {
    const { cli, quotaFile } = await setup({ fake: { admin: true }, files: [file("d2", "f2")] })
    await cli("files", "download", "deal:d2:record:f2")
    expect(existsSync(quotaFile())).toBe(false)
  })

  it("spends the slot before a made-up id is refused, so it cannot name an own deal to dodge the limit", async () => {
    const { cli, quotaFile } = await setup({ files: [file("d2", "f2")] })
    await expect(cli("files", "download", "deal:d2:record:nope")).rejects.toMatchObject({ code: "not_found" })
    expect(JSON.parse(readFileSync(quotaFile(), "utf8")).seen).toEqual(["deal:d2"])
    await expect(cli("files", "download", "deal:d1:record:f2")).rejects.toMatchObject({ code: "not_found" })
  })
})

describe("files download", () => {
  it("saves under the state folder, 700 and 600, reads the text, and keeps no token anywhere", async () => {
    const { cli, folder, dump, home } = await setup({
      files: [file("d1", "f1", { name: "../../../escape.txt" })],
    })
    const done = await cli("files", "download", "deal:d1:record:f1")
    expect(done.item).toMatchObject({ text_status: "extracted", untrusted: ["name", "mime", "path", "text"] })
    expect(done.item.text).toContain("example kitchen")
    expect(done.item.path).toBe(join(folder, "deal-d1", "escape.txt"))
    for (const { path, mode } of tree(join(home, "crm")))
      expect([path, mode]).toEqual([path, statSync(path).isDirectory() ? 0o700 : 0o600])
    expect(JSON.stringify(done)).not.toContain(FAKE_FILE_TOKEN)
    expect(dump()).toContain("example kitchen")
    expect(dump()).not.toContain(FAKE_FILE_TOKEN)
  })

  it("refuses a file over the cap before asking, stops one of unknown size at the cap, and keeps no part", async () => {
    const big = "x".repeat(2 * MB)
    const { cli, folder } = await setup({
      files: [file("d1", "known", { size: 101 * MB }), file("d1", "unknown", { size: null, bytes: big })],
    })
    await expect(cli("files", "download", "deal:d1:record:known")).rejects.toMatchObject({
      details: { reason: "crm.file-too-large", limit: 100 },
    })
    await expect(cli("files", "download", "deal:d1:record:unknown", "--max-size", "1")).rejects.toMatchObject({
      details: { reason: "crm.file-too-large", limit: 1 },
    })
    expect(tree(folder).filter(({ path }) => !statSync(path).isDirectory())).toEqual([])
    await expect(cli("files", "download", "deal:d1:record:known", "--max-size", "2049")).rejects.toThrow()
    expect((await cli("files", "download", "deal:d1:record:unknown", "--max-size", "3")).item.size).toBe(2 * MB)
  })

  it("never lets a broken, off-host or web-page answer's link out, and keeps no part", async () => {
    const { cli, folder } = await setup({
      files: [
        file("d1", "broken", { broken: true }),
        file("d1", "away", { host: "evil.example" }),
        file("d1", "page", { html: true }),
      ],
    })
    for (const id of ["broken", "away", "page"]) {
      const error = await cli("files", "download", `deal:d1:record:${id}`).catch((caught: unknown) => caught)
      expect(error).toMatchObject({ details: { reason: "crm.file-unavailable" } })
      expect(JSON.stringify(error) + String((error as Error).message)).not.toContain(FAKE_FILE_TOKEN)
    }
    expect(tree(folder).filter(({ path }) => !statSync(path).isDirectory())).toEqual([])
  })

  it("keeps two files of one record with the same name apart", async () => {
    const { cli } = await setup({
      files: [
        file("d1", "f1", { name: "contract.txt" }),
        file("d1", "f2", { name: "contract.txt", source: "activity" }),
      ],
    })
    const first = await cli("files", "download", "deal:d1:record:f1")
    const second = await cli("files", "download", "deal:d1:activity:f2")
    expect(second.item.path).not.toBe(first.item.path)
    expect(readFileSync(String(first.item.path), "utf8")).toContain("f1")
  })

  it("--dir saves the owner's own copy, not counted against the disk cap", async () => {
    const { cli, store, folder } = await setup({ files: [file("d1", "f1")] })
    const dir = mkdtempSync(join(tmpdir(), "crm-files-dir-"))
    const done = await cli("files", "download", "deal:d1:record:f1", "--dir", dir)
    expect(dirname(String(done.item.path))).toBe(dir)
    expect(await store.crmFiles.storedBytes(PORTAL, `${folder}/`)).toBe(0)
  })
})

describe("search all over file text (NEED-2707 A)", () => {
  const titles = async (cli: Awaited<ReturnType<typeof setup>>["cli"]) =>
    (await cli("search", "all", "kitchen", "--only", "crm")).items
      .filter((hit) => hit.kind === "crm_file")
      .map((hit) => hit.title)
      .sort()

  it("finds a downloaded file's text for its record's assignee and the administrator, never another user", async () => {
    const files = [file("d1", "own"), file("d2", "colleague")]
    const limited = await setup({ files })
    await limited.wholeCopy()
    await limited.cli("sync")
    await limited.cli("files", "download", "deal:d1:record:own")
    await limited.cli("files", "download", "deal:d2:record:colleague")
    expect(await titles(limited.cli)).toEqual(["own.txt"])
    const [hit] = (await limited.cli("search", "all", "kitchen", "--only", "crm")).items.filter(
      (one) => one.kind === "crm_file",
    )
    expect(hit).toMatchObject({ ref: "crmfile:deal:d1:record:own", untrusted: ["title", "excerpt"] })
    limited.run.user = "9"
    expect(await titles(limited.cli)).toEqual(["colleague.txt"])
    limited.run.user = null
    expect(await titles(limited.cli)).toEqual([])
    await limited.store.sync.setSyncState(
      PORTAL,
      "crm:viewers",
      JSON.stringify({ limited: true, admins: { "8": true } }),
    )
    limited.run.user = "8"
    expect(await titles(limited.cli)).toEqual(["colleague.txt", "own.txt"])
  })

  it("leaves file text out when the profile denies files", async () => {
    const permissions: Record<string, Level> = {}
    const { cli } = await setup({ files: [file("d1", "own")], permissions })
    await cli("sync")
    await cli("files", "download", "deal:d1:record:own")
    expect(await titles(cli)).toEqual(["own.txt"])
    permissions.files = "deny"
    expect(await titles(cli)).toEqual([])
  })
})

describe("files sync (NEED-2708 B)", () => {
  it("fetches only the own deals changed within files.days, newest first, never a colleague's", async () => {
    const { cli } = await setup({
      files: [
        file("d1", "older", { created: NOW - 2 * DAY }),
        file("d1", "newer", { created: NOW - DAY }),
        file("d2", "colleague"),
        file("d3", "stale"),
      ],
    })
    await cli("sync")
    const done = await cli("files", "sync")
    expect(done.item).toMatchObject({ complete: true, owners: 1, skipped: [] })
    expect((done.item.downloaded as { id: string }[]).map((one) => one.id)).toEqual([
      "deal:d1:record:newer",
      "deal:d1:record:older",
    ])
    expect((await cli("files", "sync")).item).toMatchObject({ owners: 0, downloaded: [] })
  })

  it("stops at max_files with run-files, saves its place, and the next run goes on", async () => {
    const { cli, settings } = await setup({ files: [file("d1", "a"), file("d1", "b"), file("d1", "c")] })
    await cli("sync")
    await settings({ max_files: 2 })
    const first = await cli("files", "sync")
    expect(first.item).toMatchObject({ complete: false, stopped: "run-files" })
    expect(first.item.skipped).toEqual([expect.objectContaining({ reason: "run-files", step: expect.any(String) })])
    expect(first.meta).toMatchObject({ complete: false })
    const second = await cli("files", "sync")
    expect(second.item).toMatchObject({
      complete: true,
      downloaded: [expect.objectContaining({ id: "deal:d1:record:c" })],
    })
  })

  it("skips a file over max_file_mb and goes on, and stops at max_run_mb", async () => {
    const { cli, settings } = await setup({
      files: [
        file("d1", "huge", { size: 21 * MB, created: NOW }),
        file("d1", "fits", { created: NOW - DAY }),
        file("d1", "over", { size: 15 * MB, created: NOW - 2 * DAY }),
      ],
    })
    await cli("sync")
    await settings({ max_run_mb: 10 })
    const done = await cli("files", "sync")
    expect(done.item).toMatchObject({ stopped: "run-mb", complete: false })
    expect((done.item.skipped as { id: string; reason: string }[]).map((one) => [one.id, one.reason])).toEqual([
      ["deal:d1:record:huge", "too-large"],
      ["deal:d1:record:over", "run-mb"],
    ])
  })

  it("stops at its run_minutes deadline on a fake clock and answers complete: false", async () => {
    let clock = NOW
    const { cli, settings } = await setup({
      files: [file("d1", "a"), file("d1", "b"), file("d1", "c")],
      now: () => {
        clock += 25_000
        return clock
      },
    })
    await cli("sync")
    await settings({ run_minutes: 1 })
    const done = await cli("files", "sync")
    expect(done.item).toMatchObject({ complete: false, stopped: "deadline" })
    expect((done.item.downloaded as unknown[]).length).toBeLessThan(3)
  })

  it("drops only files whose text is kept to make room, never a scan, and stops with disk-full", async () => {
    const { cli, settings, store, folder } = await setup({
      files: [file("d1", "new", { size: 2 * MB, bytes: "x".repeat(2 * MB) })],
    })
    await cli("sync")
    await settings({ max_total_mb: 100 })
    const row = (id: string, text: string | null, size: number, at: number) => ({
      externalId: `deal:d9:record:${id}`,
      ownerKind: "deal",
      ownerId: "d9",
      ownerAssignee: null,
      source: "record",
      name: id,
      mime: null,
      size,
      externalCreatedAt: null,
      localPath: join(folder, "deal-d9", id),
      contentSha256: null,
      text,
      extraction: text === null ? "needs-agent" : "extracted",
      extractionError: null,
      downloadedBy: "7",
      downloadedAt: at,
    })
    await store.crmFiles.save(PORTAL, row("scan", null, 60 * MB, 1))
    await store.crmFiles.save(PORTAL, row("old-text", "old words", 39 * MB, 2))
    expect((await cli("files", "sync")).item).toMatchObject({ complete: true })
    expect((await store.crmFiles.get(PORTAL, "deal:d9:record:old-text"))?.localPath).toBeNull()
    expect((await store.crmFiles.get(PORTAL, "deal:d9:record:scan"))?.localPath).not.toBeNull()
    await store.crmFiles.save(PORTAL, row("scan-2", null, 40 * MB, 3))
    await expect(cli("files", "download", "deal:d1:record:new")).rejects.toMatchObject({
      details: { reason: "crm.files-disk-full" },
    })
  })

  it("is refused when the profile denies files.download", async () => {
    const { cli } = await setup({ permissions: { "files.download": "deny" } })
    await expect(cli("files", "sync")).rejects.toMatchObject({ details: { reason: "crm.files-denied" } })
  })

  it("lets only the owner change the limits, never an agent's run", () => {
    expect(isOwnerOnlyStoreSetting("crm.example-crm:portal.files.max_total_mb")).toBe(true)
    expect(storeSettingsOf({ messenger: false })).toContain("crm.<provider>:<account>.files.max_files")
  })

  it("refuses a limit outside its range rather than clamp it", () => {
    expect(parseCrmSettingValue("files.max_files", "500")).toBe(500)
    for (const [name, value] of [
      ["files.max_files", "501"],
      ["files.max_file_mb", "0"],
      ["files.max_run_mb", "9"],
      ["files.run_minutes", "61"],
      ["files.days", "91"],
      ["files.max_total_mb", "99"],
      ["files.days", "7.5"],
    ] as const)
      expect(() => parseCrmSettingValue(name, value)).toThrow(
        expect.objectContaining({ details: expect.objectContaining({ reason: "crm.files-limit-range" }) }),
      )
  })
})

describe("review fixes", () => {
  const MBYTES = (n: number) => n * MB
  const stored = (folder: string, id: string, size: number, at: number, text: string | null = "old words") => ({
    externalId: `deal:d9:record:${id}`,
    ownerKind: "deal",
    ownerId: "d9",
    ownerAssignee: null,
    source: "record",
    name: id,
    mime: null,
    size,
    externalCreatedAt: null,
    localPath: join(folder, "deal-d9", id),
    contentSha256: null,
    text,
    extraction: text === null ? "needs-agent" : "extracted",
    extractionError: null,
    downloadedBy: "7",
    downloadedAt: at,
  })

  it("BUG-1: a repeat download does not count its own earlier copy, nor drop the file it just wrote", async () => {
    const { cli, settings, store, folder } = await setup({
      files: [file("d1", "f1", { size: null, bytes: "x".repeat(2 * MB) })],
    })
    await settings({ max_total_mb: 100 })
    const first = await cli("files", "download", "deal:d1:record:f1", "--max-size", "3")
    const path = String(first.item.path)
    const row = await store.crmFiles.get(PORTAL, "deal:d1:record:f1")
    await store.crmFiles.save(PORTAL, { ...(row as NonNullable<typeof row>), size: MBYTES(50) })
    await store.crmFiles.save(PORTAL, stored(folder, "scan", MBYTES(49), 1, null))
    const again = await cli("files", "download", "deal:d1:record:f1", "--max-size", "3")
    expect(again.item.path).toBe(path)
    expect(existsSync(path)).toBe(true)
    expect((await store.crmFiles.get(PORTAL, "deal:d1:record:f1"))?.localPath).toBe(path)
  })

  it("BUG-4: a download that fails drops no other file to make room", async () => {
    const { cli, settings, store, folder } = await setup({
      files: [file("d1", "broken", { size: MBYTES(5), broken: true })],
    })
    await settings({ max_total_mb: 100 })
    await store.crmFiles.save(PORTAL, stored(folder, "old", MBYTES(99), 1))
    await expect(cli("files", "download", "deal:d1:record:broken")).rejects.toMatchObject({
      details: { reason: "crm.file-unavailable" },
    })
    expect((await store.crmFiles.get(PORTAL, "deal:d9:record:old"))?.localPath).not.toBeNull()
  })

  it("SEC-1: --dir never overwrites a file of the owner's, and refuses when both names are taken", async () => {
    const { cli } = await setup({ files: [file("d1", "f1", { name: "contract.txt" })] })
    const dir = mkdtempSync(join(tmpdir(), "crm-files-own-"))
    writeFileSync(join(dir, "contract.txt"), "the owner's own")
    const done = await cli("files", "download", "deal:d1:record:f1", "--dir", dir)
    expect(done.item.path).toBe(join(dir, "f1-contract.txt"))
    expect(readFileSync(join(dir, "contract.txt"), "utf8")).toBe("the owner's own")
    const other = mkdtempSync(join(tmpdir(), "crm-files-own-"))
    for (const name of ["contract.txt", "f1-contract.txt"]) writeFileSync(join(other, name), "the owner's own")
    await expect(cli("files", "download", "deal:d1:record:f1", "--dir", other)).rejects.toMatchObject({
      details: { reason: "crm.file-exists" },
    })
    for (const name of ["contract.txt", "f1-contract.txt"])
      expect(readFileSync(join(other, name), "utf8")).toBe("the owner's own")
  })

  it("DEBT-1: a repeat download with --dir removes the CLI's own earlier copy", async () => {
    const { cli } = await setup({ files: [file("d1", "f1")] })
    const cached = String((await cli("files", "download", "deal:d1:record:f1")).item.path)
    await cli("files", "download", "deal:d1:record:f1", "--dir", mkdtempSync(join(tmpdir(), "crm-files-own-")))
    expect(existsSync(cached)).toBe(false)
  })

  it("UX-1: list and sync mark the path and the type untrusted", async () => {
    const { cli } = await setup({ files: [file("d1", "f1")] })
    expect((await cli("files", "list", "--deal", "d1")).items[0]?.untrusted).toEqual(["name", "mime", "path"])
    await cli("sync")
    expect((await cli("files", "sync")).item.untrusted).toEqual(["downloaded.name", "downloaded.path", "skipped.name"])
  })

  it("SEC-2: files sync downloads nothing of a deal the CRM gave a colleague since the copy was made", async () => {
    const { cli, source } = await setup({ files: [file("d1", "f1")] })
    await cli("sync")
    source.put("deal", exampleDeal("d1", { assignee: "9", updatedAt: NOW - DAY }))
    expect((await cli("files", "sync")).item).toMatchObject({ downloaded: [], complete: true })
  })

  it("BUG-2: files sync pages through every own deal, past the first 500", async () => {
    const { cli, source } = await setup({ files: [file("d1", "f1")] })
    for (let at = 0; at < 520; at += 1)
      source.put("deal", exampleDeal(`n${at}`, { assignee: "7", updatedAt: NOW - DAY + at + 1 }))
    await cli("sync")
    expect((await cli("files", "sync")).item.downloaded).toEqual([expect.objectContaining({ id: "deal:d1:record:f1" })])
  })

  it("BUG-3: a file the CRM did not give is asked for again by the next run", async () => {
    const broken = file("d1", "f1", { broken: true })
    const { cli } = await setup({ files: [broken] })
    await cli("sync")
    expect((await cli("files", "sync")).item.skipped).toEqual([expect.objectContaining({ reason: "unavailable" })])
    broken.broken = false
    expect((await cli("files", "sync")).item.downloaded).toEqual([expect.objectContaining({ id: "deal:d1:record:f1" })])
  })

  it("RISK-1: run_minutes bounds a single download, which stops and keeps no part", async () => {
    const { cli, run, folder } = await setup({ files: [file("d1", "f1")] })
    await cli("sync")
    const asked: number[] = []
    const report = await syncFiles(
      { app: APP, run, now: () => NOW },
      () => false,
      (ms) => {
        asked.push(ms)
        return AbortSignal.abort()
      },
    )
    expect(asked).toEqual([10 * 60_000])
    expect(report).toMatchObject({ downloaded: [], stopped: "deadline", complete: false })
    expect(tree(folder).filter(({ path }) => !statSync(path).isDirectory())).toEqual([])
  })
})

describe("search all outside a CRM CLI (FIND-1)", () => {
  it("applies each copy's viewer rule to deal hits when no viewers are given (SEC-200)", async () => {
    const { cli, store, wholeCopy } = await setup()
    await wholeCopy()
    await cli("sync")
    const found = await searchAll(
      store,
      { provider: "telegram", account: "1" },
      { text: "example", only: ["crm"], limit: 20 },
    )
    const deals = found.items.filter((hit) => hit.kind === "deal").map((hit) => hit.title)
    expect(deals).toContain("Example deal d1")
    expect(deals).not.toContain("Example deal d2")
  })

  it("applies each copy's viewer rule to file text when no viewers are given, as memo's and tg's do", async () => {
    const { cli, store } = await setup({ files: [file("d1", "own"), file("d2", "colleague")] })
    await cli("sync")
    await cli("files", "download", "deal:d1:record:own")
    await cli("files", "download", "deal:d2:record:colleague")
    const found = await searchAll(
      store,
      { provider: "telegram", account: "1" },
      { text: "kitchen", only: ["crm"], limit: 20 },
    )
    expect(found.items.filter((hit) => hit.kind === "crm_file").map((hit) => hit.title)).toEqual(["own.txt"])
  })
})
