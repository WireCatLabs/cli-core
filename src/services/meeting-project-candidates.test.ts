import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import type { MeetingProjectCandidateInput, MeetingProjectCandidateOptions } from "../meetings/index.js"
import type { VocabularyCatalog, VocabularyEntry, VocabularyOptions } from "../store/index.js"
import { openStore } from "../store/store.js"
import { createMeetingProjectCandidateReader } from "./meeting-project-candidates.js"

const entry = (id = "1", name = "Harbour Example"): VocabularyEntry => ({
  kind: "project",
  id,
  name,
  key: `HAR${id}`,
  scope: "work",
  aliases: [{ id: `1${id}`, name: "Гавань" }],
  usageCount: 0,
})
const fixture = (entries = [entry()]) => {
  const vocabulary = vi.fn(
    async (options: VocabularyOptions = {}): Promise<VocabularyCatalog> => ({
      entries,
      fingerprint: "v1:project:all:invented-fingerprint",
      coverage: { complete: true, maxEntries: options.maxEntries ?? 128, maxReadBytes: options.maxReadBytes ?? 65536 },
    }),
  )
  const scope = { provider: "example-calendar", account: "AliceExample" }
  return { vocabulary, scope, read: createMeetingProjectCandidateReader(scope, 11, { vocabulary: { vocabulary } }) }
}
const cue = (text = "Гавань approved the written checklist.", position = 0) => ({
  reference: `meeting:11/22/33/${position}`,
  fingerprint: "a".repeat(64),
  text,
  revision: "current" as const,
})
const input = (): MeetingProjectCandidateInput => ({
  reference: "meeting:11/22",
  title: "Harbour Example planning",
  cues: [cue()],
})

it.each(["example-calendar", "example-conference"])(
  "uses the same bounded SDK for %s and keeps hints separate",
  async (provider) => {
    const f = fixture()
    f.scope.provider = provider
    const read = createMeetingProjectCandidateReader(f.scope, 11, { vocabulary: f })
    f.scope.provider = "changed-provider"
    const result = await read(input())
    expect(result.source).toMatchObject({ provider, accountId: 11, reference: "meeting:11/22" })
    expect(result.items[0]).toMatchObject({
      project: { reference: "project:1" },
      matches: [
        { term: { name: "Harbour Example", kind: "canonical" }, source: { kind: "metadata-title", fingerprint: null } },
        {
          term: { name: "Гавань", kind: "alias", aliasId: "11" },
          source: { kind: "transcript", fingerprint: "a".repeat(64) },
        },
      ],
    })
    expect(result.association).toBe("unconfirmed-literal-evidence")
    expect(result.coverage).toMatchObject({ sourceEvidence: "not-revalidated", archiveCompleteness: "unknown" })
    expect(f.vocabulary).toHaveBeenCalledExactlyOnceWith({
      kind: "project",
      maxEntries: 128,
      maxReadBytes: 65536,
      signal: undefined,
    })
  },
)

it("matches whole literal Unicode terms, retains accents and escapes regex syntax", async () => {
  const projects = [entry("1", "año"), entry("2", "ano"), entry("3", "ёлка"), entry("4", "елка"), entry("5", "C++")]
  for (const item of projects) item.aliases = []
  const f = fixture(projects)
  const result = await f.read({
    reference: "meeting:11/22",
    cues: [cue("an\u0303o, ЁЛКА and C++; ＨＡＲ１. No HAR2suffix or prefixHAR4 or HAR3_other.")],
  })
  expect(result.items.map((item) => item.project.id)).toEqual(["1", "3", "5"])
  expect(result.items[0]?.matches.map((match) => match.term.kind)).toEqual(["canonical", "key"])
})

it("retains ambiguous projects even when a candidate limit hides one", async () => {
  const f = fixture([entry("2", "Shared Harbour"), entry("1", "Shared Harbour")])
  const result = await f.read({ reference: "meeting:11/22", title: "Shared Harbour" }, { limit: 1 })
  expect(result.items.map((item) => item.project.id)).toEqual(["1"])
  expect(result.items[0]?.matches[0]?.ambiguous).toBe(true)
  expect(result.coverage).toMatchObject({ candidatesTotal: 2, hasMore: true, outputLimited: false })
})

it("deduplicates cue references and normalized aliases without multiplying support", async () => {
  const project = entry()
  project.aliases.push({ id: "12", name: "ГАВАНЬ" })
  const f = fixture([project])
  const result = await f.read({ reference: "meeting:11/22", cues: [cue(), cue()] })
  expect(result.items[0]?.matches).toHaveLength(1)
  expect(result.items[0]?.matches[0]?.source.reference).toBe(cue().reference)
  await expect(
    f.read({ reference: "meeting:11/22", cues: [cue(), { ...cue(), text: "Changed text" }] }),
  ).rejects.toMatchObject({ code: "validation_error" })
})

it("retains historical cue provenance and changes fingerprints when evidence or vocabulary changes", async () => {
  const f = fixture()
  const a = await f.read(input())
  const b = await f.read({ reference: "meeting:11/22", cues: [{ ...cue(), revision: "superseded" }] })
  expect(b.items[0]?.matches[0]?.source.revision).toBe("superseded")
  expect(b.inputFingerprint).not.toBe(a.inputFingerprint)
  f.vocabulary.mockImplementationOnce(async () => ({
    entries: [],
    fingerprint: "changed",
    coverage: { complete: true, maxEntries: 128, maxReadBytes: 65536 },
  }))
  const c = await f.read(input())
  expect(c.vocabularyFingerprint).not.toBe(a.vocabularyFingerprint)
  expect(c.items).toEqual([])
  expect(c.coverage).toMatchObject({ candidatesTotal: 0, hasMore: false })
})

it("detaches supplied evidence before async I/O and fingerprints stable field order", async () => {
  const f = fixture(),
    data = input()
  let finish!: (catalog: VocabularyCatalog) => void
  f.vocabulary.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = f.read(data)
  data.title = "Unrelated title"
  if (data.cues?.[0]) data.cues[0].text = "Changed text"
  finish({
    entries: [entry()],
    fingerprint: "valid",
    coverage: { complete: true, maxEntries: 128, maxReadBytes: 65536 },
  })
  const captured = await pending
  expect(captured.items[0]?.matches).toHaveLength(2)
  const original = input(),
    row = cue()
  const reordered = await f.read({
    cues: [{ revision: row.revision, text: row.text, fingerprint: row.fingerprint, reference: row.reference }],
    title: original.title,
    reference: original.reference,
  })
  expect(reordered.inputFingerprint).toBe(captured.inputFingerprint)
})

it("refuses a byte limit that cannot contain mandatory provenance", async () => {
  const f = fixture()
  const read = createMeetingProjectCandidateReader({ provider: "example-calendar", account: "界".repeat(200) }, 11, {
    vocabulary: f,
  })
  await expect(read(input(), { bytes: 1024 })).rejects.toMatchObject({ code: "validation_error" })
})

it("caps returned matches and preserves coverage under output trimming", async () => {
  const f = fixture()
  const data = { reference: "meeting:11/22", cues: Array.from({ length: 30 }, (_, i) => cue("Гавань", i)) }
  const result = await f.read(data)
  expect(result.items[0]?.matches).toHaveLength(20)
  expect(result.items[0]?.omittedMatches).toBe(10)
  const compact = await f.read(data, { bytes: 1024 })
  expect(new TextEncoder().encode(JSON.stringify(compact)).byteLength).toBeLessThanOrEqual(1024)
  expect(compact.coverage).toMatchObject({ candidatesTotal: 1, hasMore: true, outputLimited: true })
  expect(compact.vocabularyFingerprint).toBe(result.vocabularyFingerprint)
})

it.each([
  { ...input(), unknown: true },
  { ...input(), reference: "meeting:12/22" },
  { ...input(), reference: "meeting:11/22/33" },
  { ...input(), title: "x".repeat(8193) },
  { ...input(), cues: [{ ...cue(), reference: "meeting:11/23/33/0" }] },
  { ...input(), cues: [{ ...cue(), reference: "meeting:11/22/33" }] },
  { ...input(), cues: [{ ...cue(), reference: "meeting:12/22/33/0" }] },
  { ...input(), cues: [{ ...cue(), fingerprint: "bad" }] },
  { ...input(), cues: [{ ...cue(), text: "x".repeat(65537) }] },
  { ...input(), cues: [{ ...cue(), hidden: true }] },
  { ...input(), cues: Array.from({ length: 101 }, () => cue()) },
  { ...input(), cues: Array.from({ length: 20 }, (_, i) => cue("界".repeat(2000), i)) },
])("rejects invalid supplied evidence before vocabulary I/O %#", async (data) => {
  const f = fixture()
  await expect(f.read(data)).rejects.toMatchObject({ code: "validation_error" })
  expect(f.vocabulary).not.toHaveBeenCalled()
})

it.each([
  { limit: 0 },
  { limit: 11 },
  { maxProjects: 129 },
  { maxVocabularyReadBytes: 65537 },
  { bytes: 1023 },
  { unknown: true },
])("rejects invalid limits before I/O %#", async (options) => {
  const f = fixture()
  await expect(f.read(input(), options as MeetingProjectCandidateOptions)).rejects.toMatchObject({
    code: "validation_error",
  })
  expect(f.vocabulary).not.toHaveBeenCalled()
})

it.each([
  { entries: [entry(), entry()] },
  { entries: [{ ...entry(), kind: "tag" }] },
  { entries: [{ ...entry(), name: "" }] },
  { entries: [{ ...entry(), aliases: [{ id: "bad", name: "alias" }] }] },
  { entries: Array.from({ length: 129 }, (_, i) => entry(String(i + 1))) },
  { fingerprint: "" },
  { coverage: { complete: false, maxEntries: 128, maxReadBytes: 65536 } },
])("refuses malformed or unbounded port results %#", async (patch) => {
  const f = fixture()
  f.vocabulary.mockImplementationOnce(
    async () =>
      ({
        entries: [entry()],
        fingerprint: "valid",
        coverage: { complete: true, maxEntries: 128, maxReadBytes: 65536 },
        ...patch,
      }) as VocabularyCatalog,
  )
  await expect(f.read(input())).rejects.toMatchObject({ code: "invalid_response" })
})

it("checks native limits, cancellation and port errors without treating gaps as no matches", async () => {
  const f = fixture()
  const controller = new AbortController()
  controller.abort()
  await expect(f.read(input(), { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" })
  expect(f.vocabulary).not.toHaveBeenCalled()
  const later = new AbortController()
  f.vocabulary.mockImplementationOnce(async () => {
    later.abort()
    return { entries: [], fingerprint: "valid", coverage: { complete: true, maxEntries: 128, maxReadBytes: 65536 } }
  })
  await expect(f.read(input(), { signal: later.signal })).rejects.toMatchObject({ code: "cancelled" })
  f.vocabulary.mockRejectedValueOnce(new Error("catalog unavailable"))
  await expect(f.read(input())).rejects.toThrow("catalog unavailable")
  expect(() => createMeetingProjectCandidateReader({ provider: "", account: "a" }, 11, { vocabulary: f })).toThrow()
  expect(() => createMeetingProjectCandidateReader(f.scope, 0, { vocabulary: f })).toThrow()
})

it("reads the existing native bounded vocabulary once without changing store bytes", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "meeting-project-candidate-")), "fixture.db")
  const store = await openStore({ path })
  try {
    const project = await store.knowledge.addProject({ name: "Harbour Example", key: "HARB" })
    await store.knowledge.addVocabularyAlias({ kind: "project", id: project.id }, "Гавань")
    const digest = () => createHash("sha256").update(readFileSync(path)).digest("hex")
    const before = digest()
    const vocabulary = vi.spyOn(store.knowledge, "vocabulary")
    const read = createMeetingProjectCandidateReader({ provider: "example-calendar", account: "AliceExample" }, 11, {
      vocabulary: store.knowledge,
    })
    expect((await read(input())).items[0]?.project.id).toBe(project.id)
    expect(vocabulary).toHaveBeenCalledOnce()
    expect(digest()).toBe(before)
    await expect(read(input(), { maxVocabularyReadBytes: 1 })).rejects.toMatchObject({
      details: { reason: "vocabulary.over-byte-budget" },
    })
    await store.knowledge.addProject({ name: "Other Example", key: "OTHR" })
    await expect(read(input(), { maxProjects: 1 })).rejects.toMatchObject({
      details: { reason: "vocabulary.over-entry-budget" },
    })
  } finally {
    await store.close()
  }
})
