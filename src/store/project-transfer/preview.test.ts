import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { projectTransferPairFixture } from "../../testing/project-transfer-pair.js"
import * as sqlite from "../sqlite/open.js"
import { previewProjectAnnotationSnapshot } from "./preview.js"

const fixtures: Awaited<ReturnType<typeof projectTransferPairFixture>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) await f.close()
})

it("reads a coherent target when a concurrent writer introduces an alias collision", async () => {
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
            f.db.prepare("UPDATE projects SET name='Studies' WHERE id=?").run(Number(f.unrelated.id))
          }
          return row
        },
      }
    }
    return opened
  })
  const initial = await previewProjectAnnotationSnapshot(request(f))
  expect(changed).toBe(true)
  expect(initial.ready).toBe(true)
  const subsequent = await previewProjectAnnotationSnapshot(request(f))
  expect(subsequent).toMatchObject({ ready: false, namespace_conflicts: [f.unrelated.ref] })
  expect(subsequent.fingerprint).not.toBe(initial.fingerprint)
})

it("detects a selected alias colliding with another project's key", async () => {
  const f = await fixture(),
    snapshot = JSON.parse(f.snapshot)
  snapshot.aliases[0].name = "PAD"
  const result = await previewProjectAnnotationSnapshot({ ...request(f), snapshot: JSON.stringify(snapshot) })
  expect(result).toMatchObject({ ready: false, namespace_conflicts: [f.unrelated.ref] })
})
const fixture = async () => {
  const f = await projectTransferPairFixture()
  fixtures.push(f)
  return f
}
const request = (f: Awaited<ReturnType<typeof fixture>>) => ({
  snapshot: f.snapshot,
  target: f.path,
  project: f.project.ref,
  bindings: f.bindings,
})
const state = (f: Awaited<ReturnType<typeof fixture>>) =>
  JSON.stringify(
    ["projects", "aliases", "facts", "links", "documents", "schema_migrations", "store_settings"].map((t) =>
      f.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(),
    ),
  )

it("previews independent different-ID source bindings from real target rows without changing either store", async () => {
  const f = await fixture(),
    before = state(f)
  const result = await previewProjectAnnotationSnapshot(request(f))
  expect(f.project.ref).not.toBe(f.source.project.ref)
  expect(f.document.ref).not.toBe(f.source.document.ref)
  expect(result).toMatchObject({
    ready: true,
    descriptor_conflicts: [],
    namespace_conflicts: [],
    plan: { ready: true, missing_bindings: [], conflicts: [] },
  })
  expect(result.read_bytes).toBeGreaterThan(8192)
  expect(JSON.stringify(result)).not.toContain("INVENTED_CORPUS_SENTINEL")
  expect(JSON.stringify(result)).not.toContain(dirname(f.path))
  expect(state(f)).toBe(before)
  expect((await previewProjectAnnotationSnapshot(request(f))).fingerprint).toBe(result.fingerprint)
  expect((await f.source.store.facts.get(f.source.proposed.ref))?.status).toBe("proposed")
})

it("reports changed target source content and binds it to the preview fingerprint", async () => {
  const f = await fixture(),
    initial = await previewProjectAnnotationSnapshot(request(f))
  f.db.prepare("UPDATE documents SET body='A changed source' WHERE id=?").run(Number(f.document.id))
  const changed = await previewProjectAnnotationSnapshot(request(f))
  expect(changed.ready).toBe(false)
  expect(changed.plan.conflicts).toContainEqual({ reference: f.source.document.ref, reason: "changed" })
  expect(changed.fingerprint).not.toBe(initial.fingerprint)
})

it("reports another project's normalized alias collision and a mismatched baseline descriptor", async () => {
  const f = await fixture(),
    initial = await previewProjectAnnotationSnapshot(request(f))
  await f.store.knowledge.addVocabularyAlias({ kind: "project", id: f.unrelated.id }, " studies ")
  f.db.prepare("UPDATE projects SET name='Different research' WHERE id=?").run(Number(f.project.id))
  const changed = await previewProjectAnnotationSnapshot(request(f))
  expect(changed).toMatchObject({
    ready: false,
    descriptor_conflicts: ["name"],
    namespace_conflicts: [f.unrelated.ref],
  })
  expect(changed.fingerprint).not.toBe(initial.fingerprint)
})

it("refuses a populated annotation target without accepting or copying facts", async () => {
  const f = await fixture()
  await f.store.facts.add({ type: "statement", statement: "Already present", project: f.project.ref, by: "owner" })
  const before = state(f),
    result = await previewProjectAnnotationSnapshot(request(f))
  expect(result.ready).toBe(false)
  expect(result.plan.conflicts).toContainEqual({ reference: f.project.ref, reason: "populated" })
  expect(state(f)).toBe(before)
})

it("reports absent and wrong-kind explicit references rather than resolving names", async () => {
  const f = await fixture(),
    bindings = {
      ...f.bindings,
      [f.source.document.ref]: "document:999999",
      [`bot:${f.source.proposed.author.id}`]: "person:1",
    }
  const result = await previewProjectAnnotationSnapshot({ ...request(f), bindings })
  expect(result.ready).toBe(false)
  expect(result.plan.conflicts).toContainEqual({ reference: f.source.document.ref, reason: "missing" })
  expect(result.plan.conflicts).toContainEqual({
    reference: `bot:${f.source.proposed.author.id}`,
    reason: "wrong_kind",
  })
})

it("refuses budgets, malformed options and a missing target without creating it", async () => {
  const f = await fixture(),
    missing = join(dirname(f.path), "missing.db"),
    before = state(f)
  await expect(previewProjectAnnotationSnapshot({ ...request(f), maxReadBytes: 4096 })).rejects.toMatchObject({
    code: "validation_error",
  })
  await expect(previewProjectAnnotationSnapshot({ ...request(f), target: missing })).rejects.toMatchObject({
    code: "not_found",
  })
  await expect(
    previewProjectAnnotationSnapshot(Object.assign({ ...request(f), target: missing }, { unexpected: true })),
  ).rejects.toMatchObject({ code: "validation_error", message: expect.stringContaining("unexpected") })
  expect(existsSync(missing)).toBe(false)
  expect(state(f)).toBe(before)
})
