import { afterEach, expect, it } from "vitest"
import { projectTransferPairFixture } from "../../testing/project-transfer-pair.js"
import { openStore } from "../store.js"
import { snapshotProjectAnnotations } from "./snapshot.js"
import { projectAnnotationSnapshotFingerprint } from "./snapshot-model.js"
import type { ProjectAnnotationStore } from "./store.js"

const fixtures: Awaited<ReturnType<typeof projectTransferPairFixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close()
})
const fixture = async () => {
  const f = await projectTransferPairFixture()
  fixtures.push(f)
  return f
}
const request = (f: Awaited<ReturnType<typeof fixture>>) => ({
  snapshot: f.snapshot,
  project: f.project.ref,
  bindings: f.bindings,
})
const port = (f: Awaited<ReturnType<typeof fixture>>): ProjectAnnotationStore => {
  if (!f.store.projectAnnotations) throw new Error("Missing transfer port")
  return f.store.projectAnnotations
}
const state = (f: Awaited<ReturnType<typeof fixture>>) =>
  JSON.stringify(
    [
      "projects",
      "aliases",
      "facts",
      "links",
      "documents",
      "persons",
      "bots",
      "accounts",
      "schema_migrations",
      "store_settings",
    ].map((t) => f.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()),
  )

it("preserves superseded and reversed decision history with mapped predecessor references", async () => {
  const f = await fixture(),
    api = port(f)
  const replacement = await f.source.store.facts.add({
    type: "decision",
    statement: "A later decision",
    by: "owner",
    project: f.source.project.ref,
    supersedes: f.source.accepted.ref,
  })
  await f.source.store.facts.reverse(replacement.ref)
  const source = await snapshotProjectAnnotations({ source: f.source.path, project: f.source.project.ref })
  const input = { ...request(f), snapshot: JSON.stringify(source.snapshot) }
  const preview = await api.preview(input),
    receipt = await api.restore({ ...input, fingerprint: preview.fingerprint })
  const old = await f.store.facts.get(receipt.mappings[f.source.accepted.ref] ?? "missing")
  const newer = await f.store.facts.get(receipt.mappings[replacement.ref] ?? "missing")
  expect(old.status).toBe("superseded")
  expect(newer.status).toBe("reversed")
  expect(newer.supersedes).toBe(old.ref)
  expect(newer.confirmedBy).toEqual(replacement.confirmedBy)
  expect(newer.createdAt).toBe(replacement.createdAt)
})

it("maps a fact subject referencing a later owned fact", async () => {
  const f = await fixture(),
    api = port(f)
  const later = await f.source.store.facts.add({
    type: "statement",
    statement: "A later supporting record",
    by: "owner",
    project: f.source.project.ref,
  })
  f.source.db
    .prepare("UPDATE facts SET subject_type='fact',subject_id=? WHERE id=?")
    .run(Number(later.id), Number(f.source.proposed.id))
  const source = await snapshotProjectAnnotations({ source: f.source.path, project: f.source.project.ref })
  const input = { ...request(f), snapshot: JSON.stringify(source.snapshot) },
    preview = await api.preview(input)
  const receipt = await api.restore({ ...input, fingerprint: preview.fingerprint })
  const restored = await f.store.facts.get(receipt.mappings[f.source.proposed.ref] ?? "missing")
  expect(restored.subject).toBe(receipt.mappings[later.ref])
  expect(restored.status).toBe("proposed")
})

it("keeps a native read-only store incapable of restoration", async () => {
  const f = await fixture(),
    readOnly = await openStore({ path: f.path, readOnly: true }),
    before = state(f)
  try {
    const api = readOnly.projectAnnotations
    if (!api) throw new Error("Missing transfer port")
    const input = request(f),
      preview = await api.preview(input)
    await expect(api.restore({ ...input, fingerprint: preview.fingerprint })).rejects.toMatchObject({
      code: "configuration_error",
    })
    expect(state(f)).toBe(before)
  } finally {
    await readOnly.close()
  }
})

it("atomically restores selected history through the public port with explicit different-ID bindings", async () => {
  const f = await fixture(),
    api = port(f),
    input = request(f)
  const shared = () =>
    JSON.stringify({
      documents: f.db.prepare("SELECT * FROM documents ORDER BY id").all(),
      actors: f.db.prepare("SELECT * FROM bots ORDER BY id").all(),
      organizations: f.db.prepare("SELECT * FROM organizations ORDER BY id").all(),
      project: f.db.prepare("SELECT * FROM projects WHERE id=?").get(Number(f.unrelated.id)),
      facts: f.db.prepare("SELECT * FROM facts WHERE project_id=? ORDER BY id").all(Number(f.unrelated.id)),
    })
  const before = shared(),
    preview = await api.preview(input)
  expect(preview.ready).toBe(true)
  const receipt = await api.restore({ ...input, fingerprint: preview.fingerprint })
  expect(receipt.counts).toEqual({ aliases: 1, facts: 2, links: 3 })
  expect(shared()).toBe(before)
  const original = JSON.parse(f.snapshot),
    map = (ref: string | null) => (ref === null ? null : (receipt.mappings[ref] ?? ref))
  const expected = {
    ...original,
    project: {
      ...original.project,
      ref: f.project.ref,
      organization: map(original.project.organization),
      owner: map(original.project.owner),
    },
    facts: original.facts.map((fact: Record<string, unknown>) => ({
      ...fact,
      ...Object.fromEntries(
        ["ref", "subject", "supersedes", "author", "confirmed_by"].map((key) => [key, map(fact[key] as string | null)]),
      ),
    })),
    links: original.links.map((link: Record<string, unknown>) => ({
      ...link,
      ...Object.fromEntries(["ref", "from", "to"].map((key) => [key, map(link[key] as string | null)])),
    })),
    external: original.external.map((e: { ref: string; content_sha256: string | null }) => ({ ...e, ref: map(e.ref) })),
  }
  const actual = await snapshotProjectAnnotations({ source: f.path, project: f.project.ref })
  expect(actual.fingerprint).toBe(projectAnnotationSnapshotFingerprint(JSON.stringify(expected)))
  expect(actual.snapshot.facts.map((fact) => fact.status)).toEqual(["proposed", "accepted"])
  expect(actual.snapshot.facts[0]?.author).not.toBe(original.facts[0].author)
  await expect(api.restore({ ...input, fingerprint: preview.fingerprint })).rejects.toMatchObject({
    code: "validation_error",
  })
  expect((await snapshotProjectAnnotations({ source: f.path, project: f.project.ref })).fingerprint).toBe(
    actual.fingerprint,
  )
})

it("rolls back descriptor, aliases and earlier fact insertion when a later insertion fails", async () => {
  const f = await fixture(),
    api = port(f),
    input = request(f),
    preview = await api.preview(input)
  f.db.exec(
    "CREATE TRIGGER invented_restore_failure BEFORE INSERT ON facts WHEN NEW.statement='Review before proceeding' BEGIN SELECT RAISE(ABORT,'invented failure'); END",
  )
  const before = state(f)
  await expect(api.restore({ ...input, fingerprint: preview.fingerprint })).rejects.toMatchObject({
    code: "configuration_error",
    message: expect.stringContaining("rolled back"),
  })
  expect(state(f)).toBe(before)
})

it.each(["source", "namespace", "selected target"])(
  "refuses a stale %s preview before changing annotations",
  async (change) => {
    const f = await fixture(),
      api = port(f),
      input = request(f),
      preview = await api.preview(input)
    if (change === "source")
      f.db.prepare("UPDATE documents SET body='Changed content' WHERE id=?").run(Number(f.document.id))
    if (change === "namespace")
      f.db.prepare("UPDATE projects SET name='Studies' WHERE id=?").run(Number(f.unrelated.id))
    if (change === "selected target")
      await f.store.facts.add({ type: "statement", statement: "New annotation", project: f.project.ref, by: "owner" })
    const before = state(f)
    await expect(api.restore({ ...input, fingerprint: preview.fingerprint })).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(state(f)).toBe(before)
  },
)

it("refuses missing or unknown restore arguments without writing", async () => {
  const f = await fixture(),
    api = port(f),
    input = request(f),
    before = state(f)
  await expect(api.restore({ ...input, fingerprint: "" })).rejects.toMatchObject({ code: "validation_error" })
  await expect(
    api.restore(Object.assign({ ...input, fingerprint: "a".repeat(64) }, { unexpected: true })),
  ).rejects.toMatchObject({ code: "validation_error", message: expect.stringContaining("unexpected") })
  expect(state(f)).toBe(before)
})
