import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { projectSnapshotFixture } from "../../testing/project-snapshot.js"
import * as sqlite from "../sqlite/open.js"
import {
  decodeProjectAnnotationSnapshot,
  projectAnnotationSnapshotFingerprint,
  snapshotProjectAnnotations,
} from "./snapshot.js"

const fixtures: Awaited<ReturnType<typeof projectSnapshotFixture>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const fixture of fixtures.splice(0)) {
    await fixture.close()
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})
const fixture = async (padding = false) => {
  const f = await projectSnapshotFixture(padding)
  fixtures.push(f)
  return f
}

it("reads one project's annotation history through a native read-only handle without corpus bodies or source changes", async () => {
  const f = await fixture()
  const before = () =>
    Object.fromEntries(
      ["projects", "aliases", "facts", "links", "documents", "store_settings", "schema_migrations"].map((table) => [
        table,
        f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    )
  const initial = before(),
    opened = vi.spyOn(sqlite, "openSqlite")
  const result = await snapshotProjectAnnotations({ source: f.path, project: f.project.ref })
  expect(opened).toHaveBeenCalledWith(f.path, { readOnly: true })
  const s = result.snapshot
  expect(s.project).toMatchObject({
    ref: f.project.ref,
    name: "Research",
    description: "A synthetic study",
    status: "active",
    created_at: f.at,
    updated_at: f.at,
    account_scope: "owner",
  })
  expect(s.aliases).toEqual([{ name: "Studies", source: "owner", display: false, created_at: f.at, updated_at: f.at }])
  expect(s.facts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        ref: f.proposed.ref,
        status: "proposed",
        author: `bot:${f.proposed.author.id}`,
        model: "synthetic-model",
      }),
      expect.objectContaining({
        ref: f.accepted.ref,
        status: "accepted",
        confirmed_by: "person:1",
        occurred_at: f.at - 1000,
      }),
    ]),
  )
  expect(s.links).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        origin: "suggested",
        confirmed: false,
        role: "key",
        provenance: "synthetic suggestion",
      }),
    ]),
  )
  expect(s.external.find((e) => e.ref === f.document.ref)?.content_sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(s.coverage).toMatchObject({
    facts: "complete",
    links: "complete",
    tasks: "omitted",
    memories: "omitted",
    findings: "omitted",
  })
  expect(JSON.stringify(s)).not.toContain("INVENTED_CORPUS_SENTINEL")
  expect(JSON.stringify(s)).not.toContain(f.directory)
  expect(before()).toEqual(initial)
  expect(decodeProjectAnnotationSnapshot(JSON.stringify(s))).toEqual(s)
  expect(projectAnnotationSnapshotFingerprint(JSON.stringify(s))).toBe(result.fingerprint)
})

it("uses portable content hashes when identical source text has different store IDs", async () => {
  const a = await fixture(),
    b = await fixture(true)
  const one = await snapshotProjectAnnotations({ source: a.path, project: a.project.ref })
  const two = await snapshotProjectAnnotations({ source: b.path, project: b.project.ref })
  expect(a.document.ref).not.toBe(b.document.ref)
  expect(one.snapshot.external.find((e) => e.ref === a.document.ref)?.content_sha256).toBe(
    two.snapshot.external.find((e) => e.ref === b.document.ref)?.content_sha256,
  )
  expect(one.snapshot.facts).toHaveLength(2)
  expect(two.snapshot.facts).toHaveLength(2)
})

it("keeps whitespace-only metadata invalid while exposing a structural transport schema", async () => {
  const f = await fixture(),
    result = await snapshotProjectAnnotations({ source: f.path, project: f.project.ref })
  const source = result.snapshot.aliases[0]
  if (!source) throw new Error("Missing synthetic alias")
  source.source = "  "
  expect(() => decodeProjectAnnotationSnapshot(JSON.stringify(result.snapshot))).toThrow("aliases.source")
  source.source = "owner"
  result.snapshot.project.description = "  "
  expect(() => decodeProjectAnnotationSnapshot(JSON.stringify(result.snapshot))).toThrow("project.description")
})

it("refuses oversized source text and invalid budgets without changing the source or creating a missing store", async () => {
  const f = await fixture()
  await expect(
    snapshotProjectAnnotations({ source: f.path, project: f.project.ref, maxReadBytes: 4096 }),
  ).rejects.toMatchObject({ code: "validation_error" })
  expect(f.db.prepare("SELECT body FROM documents WHERE id=?").get(Number(f.document.id))?.body).toBe(f.corpus)
  const missing = join(f.directory, "missing.db")
  await expect(
    snapshotProjectAnnotations({ source: missing, project: f.project.ref, maxReadBytes: 0 }),
  ).rejects.toMatchObject({ code: "validation_error" })
  expect(existsSync(missing)).toBe(false)
  await expect(snapshotProjectAnnotations({ source: missing, project: f.project.ref })).rejects.toMatchObject({
    code: "not_found",
  })
  expect(existsSync(missing)).toBe(false)
})

it.each([
  "UPDATE facts SET metadata='{}'",
  "UPDATE links SET metadata='{\"future\":true}'",
  "UPDATE aliases SET account_id=(SELECT min(id) FROM accounts)",
  "UPDATE facts SET deleted_at=1",
])("refuses unsupported source state instead of producing an incomplete export: %s", async (sql) => {
  const f = await fixture()
  f.db.exec(sql)
  await expect(snapshotProjectAnnotations({ source: f.path, project: f.project.ref })).rejects.toMatchObject({
    code: "configuration_error",
  })
})

it("keeps one consistent source snapshot when a separate writer commits between metadata and hydration", async () => {
  const f = await fixture(),
    original = sqlite.openSqlite
  let changed = false
  vi.spyOn(sqlite, "openSqlite").mockImplementation(async (...args) => {
    const opened = await original(...args),
      execute = opened.database.exec.bind(opened.database),
      prepare = opened.database.prepare.bind(opened.database)
    let reading = false
    opened.database.exec = (sql) => {
      execute(sql)
      if (sql.startsWith("SAVEPOINT r")) reading = true
    }
    opened.database.prepare = (sql) => {
      const statement = prepare(sql)
      return {
        ...statement,
        get: (...parameters) => {
          const row = statement.get(...parameters)
          if (reading && !changed) {
            changed = true
            f.db.prepare("UPDATE facts SET statement='A later source version' WHERE id=?").run(Number(f.proposed.id))
          }
          return row
        },
      }
    }
    return opened
  })
  const read = await snapshotProjectAnnotations({ source: f.path, project: f.project.ref })
  expect(changed).toBe(true)
  expect(read.snapshot.facts.find((fact) => fact.ref === f.proposed.ref)?.statement).toBe(
    "The sender reported a delivery",
  )
  expect(f.db.prepare("SELECT statement FROM facts WHERE id=?").get(Number(f.proposed.id))?.statement).toBe(
    "A later source version",
  )
})

it("refuses a future additive schema without attempting source maintenance", async () => {
  const f = await fixture()
  const latest = Number(f.db.prepare("SELECT max(version) AS version FROM schema_migrations").get()?.version)
  f.db.prepare("INSERT INTO schema_migrations(version,min_compatible,applied_at) VALUES(?,?,0)").run(latest + 1, latest)
  const before = f.db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()
  await expect(snapshotProjectAnnotations({ source: f.path, project: f.project.ref })).rejects.toMatchObject({
    code: "configuration_error",
  })
  expect(f.db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(before)
})
