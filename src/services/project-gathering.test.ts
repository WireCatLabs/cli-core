import { CliError } from "@wirecat/cli-base"
import { afterEach, expect, it, vi } from "vitest"
import { type ContextEvidenceReader, type ContextSource, contextEvidenceFingerprint } from "../context/evidence.js"
import { drainNoteIndex } from "../store/sqlite/note-index.js"
import { stemmerCache } from "../store/sqlite/stems.js"
import { contextEvidenceFixture } from "../testing/context-evidence.js"
import { gatherProjectEvidence, type ProjectSourceFetcher } from "./project-gathering.js"
import { storedMessageNeighbours, storedNeighbours } from "./project-gathering-around.js"
import { findEvidenceMentions } from "./project-gathering-mentions.js"
import type { ProjectGatheringRequest } from "./project-gathering-request.js"

const DAY = 86400000
const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close()
})
const fixture = async () => {
  const f = await contextEvidenceFixture()
  handles.push(f)
  const sources = [f.sources.message, f.sources.mail, f.sources.document]
  const request: ProjectGatheringRequest = {
    project: { name: "Harbour", aliases: ["launch"] },
    sources,
    scope: "explicit",
    after: 0,
    before: 10000,
  }
  return { ...f, sources, request }
}
const present = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error("Missing fixture value")
  return value
}

it("unions alias lanes over every selected source and keeps each lane that found a reference", async () => {
  const f = await fixture()
  const result = await gatherProjectEvidence({ evidence: f.port }, f.request)
  expect(result.lanes).toEqual([
    { id: "l1", kinds: ["project"], query: "Harbour", people: [] },
    { id: "l2", kinds: ["alias"], query: "launch", people: [] },
  ])
  const refs = result.items.map((i) => i.ref)
  expect(new Set(refs).size).toBe(refs.length)
  expect(result.items.find((i) => i.ref.endsWith("/planning/3"))).toMatchObject({
    kind: "message",
    lanes: ["l1", "l2"],
    context: "project",
    timeKind: "sent",
  })
  expect(result.items.find((i) => i.ref === f.doc.ref)).toMatchObject({ kind: "document", timeKind: "stored-update" })
  expect(result.items.some((i) => i.kind === "mail")).toBe(true)
  expect(result).toMatchObject({ complete: true, checkpoint: null, stopped: null, completeness: "unknown" })
  expect(result.units.every((u) => u.state === "done")).toBe(true)
})

it("marks evidence found only through a person's name as context, not project membership", async () => {
  const f = await fixture()
  const result = await gatherProjectEvidence(
    { evidence: f.port },
    { ...f.request, project: { name: "Zeppelin" }, people: [{ name: "Harbour", reference: "person:7" }] },
  )
  expect(result.lanes[1]).toEqual({ id: "l2", kinds: ["person"], query: "Harbour", people: ["person:7"] })
  expect(result.items.length).toBeGreaterThan(0)
  expect(result.items.every((i) => i.context === "person-only" && i.lanes.join() === "l2")).toBe(true)
})

it("defaults to sixty days before asOf, freezes it on resume and splits long windows into 90-day reads", async () => {
  const f = await fixture()
  const asOf = 200 * DAY
  const sixty = await gatherProjectEvidence(
    { evidence: f.port },
    { ...f.request, after: undefined, before: undefined, asOf },
  )
  expect(sixty.window).toMatchObject({ after: 140 * DAY, before: asOf, lookbackDays: 60, basis: "lookback" })

  const long = { ...f.request, after: undefined, before: undefined, lookbackDays: 200, budgets: { maxReads: 1 } }
  let clock = asOf
  const first = await gatherProjectEvidence({ evidence: f.port, now: () => clock }, long)
  expect([...new Set(first.units.map((u) => `${u.after}-${u.before}`))]).toEqual([
    `${110 * DAY}-${200 * DAY}`,
    `${20 * DAY}-${110 * DAY}`,
    `0-${20 * DAY}`,
  ])
  clock += 30 * DAY
  const resumed = await gatherProjectEvidence(
    { evidence: f.port, now: () => clock },
    { ...long, checkpoint: present(first.checkpoint) },
  )
  expect(resumed).toMatchObject({ resumed: true, window: { after: 0, before: asOf, asOf } })
})

it("stops at the read budget after first pages, resumes without repeating evidence and refuses a changed request", async () => {
  const f = await fixture()
  const read = vi.spyOn(f.port, "read")
  const budgeted = { ...f.request, runKey: "nbb-1", budgets: { maxReads: 3 } }
  const first = await gatherProjectEvidence({ evidence: f.port }, budgeted)
  expect(first).toMatchObject({ stopped: "reads", complete: false, usage: { reads: 3 } })
  expect(read.mock.calls.map(([r]) => [r.query, r.source.kind])).toEqual([
    ["Harbour", "message"],
    ["Harbour", "mail"],
    ["Harbour", "document"],
  ])
  const checkpoint = present(first.checkpoint)
  const second = await gatherProjectEvidence({ evidence: f.port }, { ...f.request, runKey: "nbb-1", checkpoint })
  expect(second).toMatchObject({ complete: true, checkpoint: null, totals: { reads: 6, invocations: 2 } })
  const firstRefs = new Set(first.items.map((i) => i.ref))
  expect(second.items.some((i) => firstRefs.has(i.ref))).toBe(false)
  expect(second.matchedAgain.map((m) => m.ref).every((ref) => firstRefs.has(ref))).toBe(true)
  expect(second.matchedAgain.every((m) => m.lanes.join() === "l2")).toBe(true)

  await expect(
    gatherProjectEvidence({ evidence: f.port }, { ...budgeted, keywords: ["checklist"], checkpoint }),
  ).rejects.toMatchObject({ code: "validation_error", details: { param: "checkpoint" } })
  await expect(
    gatherProjectEvidence({ evidence: f.port }, { ...budgeted, runKey: "other", checkpoint }),
  ).rejects.toMatchObject({ code: "validation_error" })
})

it("keeps a failed connector and a failed source as coverage while other sources are still read", async () => {
  const f = await fixture()
  const fetcher: ProjectSourceFetcher = {
    fetch: vi.fn(async ({ source }) => {
      if (source.kind === "mail") throw new CliError("network_error", "mail server unreachable")
      return {
        status: source.kind === "document" ? ("unsupported" as const) : ("fetched" as const),
        history: "partial" as const,
      }
    }),
  }
  const evidence: ContextEvidenceReader = {
    read: (request) =>
      request.source.kind === "mail"
        ? Promise.reject(new CliError("provider_error", "mail index unreadable"))
        : f.port.read(request),
  }
  const result = await gatherProjectEvidence({ evidence, fetcher }, { ...f.request, fetch: "before-read" })
  expect(result.fetch.map((s) => [s.state, s.code])).toEqual([
    ["fetched", null],
    ["failed", "network_error"],
    ["unsupported", null],
  ])
  expect(result.units.filter((u) => u.source === 1).map((u) => [u.state, u.issue])).toEqual([
    ["failed", "provider_error"],
    ["failed", "provider_error"],
  ])
  expect(result.items.some((i) => i.kind === "message")).toBe(true)
  expect(result.complete).toBe(true)
  expect(result.completeness).toBe("unknown")
})

it("returns no evidence without claiming the project has none", async () => {
  const f = await fixture()
  const result = await gatherProjectEvidence({ evidence: f.port }, { ...f.request, project: { name: "Zeppelin" } })
  expect(result).toMatchObject({ items: [], complete: true, completeness: "unknown" })
  expect(result.units.every((u) => u.state === "done" && u.pages === 1)).toBe(true)
})

it.each([
  [{ scope: undefined }, "scope"],
  [{ sources: [] }, "sources"],
  [{ keywords: ["one two three four five six seven eight nine ten a b c d e f g"] }, "keywords.0"],
  [{ lookbackDays: 30 }, "lookbackDays"],
  [{ budgets: { maxPages: 2 } }, "budgets.maxPages"],
  [{ extra: true }, "extra"],
  [{ fetch: "before-read" }, "fetch"],
])("refuses %o before reading any source", async (change, param) => {
  const f = await fixture()
  const read = vi.spyOn(f.port, "read")
  await expect(
    gatherProjectEvidence({ evidence: f.port }, { ...f.request, ...change } as ProjectGatheringRequest),
  ).rejects.toMatchObject({ details: { param } })
  expect(read).not.toHaveBeenCalled()
})

it("brings the mail and document index up to date before reading, unless asked to read it as it is", async () => {
  const f = await fixture()
  const pend = () => {
    f.db
      .prepare("INSERT OR REPLACE INTO document_index_pending(indexable_type,id) VALUES('document',?)")
      .run(Number(f.doc.id))
  }
  pend()
  const asIs = await gatherProjectEvidence(
    { evidence: f.port, index: f.store.contextIndex },
    { ...f.request, index: "as-is" },
  )
  expect(asIs.index).toEqual({ state: "as-is", mail: 0, documents: 0, code: null })
  expect(asIs.units.filter((u) => u.source === 2).every((u) => u.issue === "index-pending")).toBe(true)
  expect(asIs.items.some((i) => i.kind === "document")).toBe(false)

  const updated = await gatherProjectEvidence({ evidence: f.port, index: f.store.contextIndex }, f.request)
  expect(updated.index).toMatchObject({ state: "updated", code: null })
  expect(updated.units.every((u) => u.issue === null)).toBe(true)
  expect(updated.items.some((i) => i.kind === "document")).toBe(true)

  pend()
  const hostless = await gatherProjectEvidence({ evidence: f.port }, f.request)
  expect(hostless.index.state).toBe("unavailable")
  const failing = await gatherProjectEvidence(
    { evidence: f.port, index: { catchUp: () => Promise.reject(new CliError("permission_error", "read-only store")) } },
    f.request,
  )
  expect(failing.index).toMatchObject({ state: "failed", code: "permission_error" })
})

it("searches the project key as its own lane and lets a window start without an end", async () => {
  const f = await fixture()
  const result = await gatherProjectEvidence(
    { evidence: f.port },
    { ...f.request, project: { name: "Zeppelin", key: "Harbour" }, after: 0, before: undefined, asOf: 10000 },
  )
  expect(result.lanes[1]).toEqual({ id: "l2", kinds: ["key"], query: "Harbour", people: [] })
  expect(result.items.every((i) => i.lanes.join() === "l2" && i.context === "project")).toBe(true)
  expect(result.window).toMatchObject({ after: 0, before: 10000, basis: "explicit" })
  await expect(
    gatherProjectEvidence({ evidence: f.port }, { ...f.request, after: undefined, before: 10000 }),
  ).rejects.toMatchObject({ details: { param: "after" } })
})

it("raises the default read budget to finish one round of every search over every source", async () => {
  const f = await fixture()
  const keywords = Array.from({ length: 14 }, (_, n) => `word${n}`)
  const result = await gatherProjectEvidence({ evidence: f.port }, { ...f.request, keywords, before: 91 * DAY })
  expect(result.units).toHaveLength(16 * 3 * 2)
  expect(result).toMatchObject({ stopped: null, complete: true, usage: { reads: 96 } })
  const capped = await gatherProjectEvidence(
    { evidence: f.port },
    { ...f.request, keywords, before: 91 * DAY, budgets: { maxReads: 48 } },
  )
  expect(capped).toMatchObject({ stopped: "reads", usage: { reads: 48 } })
})

it("attaches the messages next to a message hit as cited context, not as new matches", async () => {
  const f = await fixture()
  f.db
    .prepare(
      "INSERT INTO messages(chat_id,account_id,external_id,sent_at,text,normalized_text,normalizer_version,created_at,updated_at,source) VALUES(?,?,'4',250,'Ok, tomorrow','ok tomorrow',1,0,0,'history')",
    )
    .run(f.accountId, f.accountId)
  const neighbours = storedMessageNeighbours(f.store.messages)
  const result = await gatherProjectEvidence(
    { evidence: f.port, neighbours },
    { ...f.request, sources: [f.sources[0], f.sources[1]] as ContextSource[], around: { before: 1, after: 1 } },
  )
  const third = result.items.find((i) => i.ref.endsWith("/planning/3"))
  expect(third?.around).toEqual([
    expect.objectContaining({ ref: third?.ref.replace(/3$/, "4"), text: "Ok, tomorrow", found: false }),
  ])
  const second = result.items.find((i) => i.ref.endsWith("/planning/2"))
  expect(second?.around?.map((n) => [n.ref.split("/").pop(), n.found])).toEqual([
    ["1", true],
    ["4", false],
  ])
  expect(result.items.some((i) => i.ref.endsWith("/planning/4"))).toBe(false)
  expect(result.items.find((i) => i.kind === "mail")?.around).toEqual([])
  expect(result.usage.aroundBytes).toBeGreaterThan(0)

  const plain = await gatherProjectEvidence(
    { evidence: f.port },
    { ...f.request, sources: [f.sources[0]] as ContextSource[] },
  )
  const tight = await gatherProjectEvidence(
    { evidence: f.port, neighbours },
    {
      ...f.request,
      sources: [f.sources[0]] as ContextSource[],
      budgets: { maxReadBytes: plain.usage.readBytes + 10, maxPageBytes: 65536 },
    },
  )
  expect(tight.items.some((i) => i.aroundIssue === "read-bytes")).toBe(true)
  const none = await gatherProjectEvidence(
    { evidence: f.port, neighbours },
    { ...f.request, around: { before: 0, after: 0 } },
  )
  expect(none.items.every((i) => i.around === undefined)).toBe(true)
})

it("names the other projects the returned excerpts mention, cited and unconfirmed, without the gathered one", async () => {
  const f = await fixture()
  const launch = await f.store.knowledge.addProject({ name: "Launch", key: "LCH" })
  const checklist = await f.store.knowledge.addProject({ name: "Checklist" })
  const gathering = await gatherProjectEvidence({ evidence: f.port }, f.request)
  const all = await findEvidenceMentions(f.store.knowledge, gathering)
  expect(all).toMatchObject({ association: "unconfirmed-literal-evidence", coverage: { skipped: [], hasMore: false } })
  const launchMention = all.items.find((m) => m.target.reference === `project:${launch.id}`)
  expect(launchMention?.matches.length).toBeGreaterThan(1)
  expect(launchMention?.matches[0]).toMatchObject({ term: { name: "Launch", kind: "canonical" }, in: "hit" })
  expect(all.items.find((m) => m.target.reference === `project:${checklist.id}`)?.matches).toEqual([
    expect.objectContaining({ reference: f.doc.ref, in: "hit" }),
  ])
  const others = await findEvidenceMentions(f.store.knowledge, gathering, { exclude: `project:${launch.id}` })
  expect(others.items.map((m) => m.target.reference)).not.toContain(`project:${launch.id}`)

  const failing = {
    vocabulary: async (options?: { kind?: string }) => {
      if (options?.kind === "tag")
        throw new CliError("validation_error", "too many", { reason: "vocabulary.over-entry-budget" })
      return f.store.knowledge.vocabulary(options as Parameters<typeof f.store.knowledge.vocabulary>[0])
    },
  }
  const partial = await findEvidenceMentions(failing, gathering)
  expect(partial.coverage.skipped).toEqual([
    { kind: "tag", code: "validation_error", reason: "vocabulary.over-entry-budget" },
  ])
  expect(partial.items.length).toBe(all.items.length)
})

it("gives a mail hit the emails before and after it in its thread", async () => {
  const f = await fixture()
  f.db
    .prepare(
      "INSERT INTO emails(id,account_id,email_thread_id,external_id,subject,body_text,from_name,sent_at,created_at,updated_at) VALUES(2,?,1,'reply','Re: Harbour','Thanks, signed',?,250,0,0)",
    )
    .run(f.mailId, "Rita Example")
  const result = await gatherProjectEvidence(
    { evidence: f.port, neighbours: storedNeighbours(f.store) },
    { ...f.request, sources: [f.sources[1]] as ContextSource[] },
  )
  const letter = result.items.find((i) => i.ref === "msg:email/example-mail/thread/letter")
  expect(letter?.around).toEqual([
    {
      ref: "msg:email/example-mail/thread/reply",
      at: 250,
      sender: "Rita Example",
      text: "Re: Harbour — Thanks, signed",
      found: false,
    },
  ])
})

it("gives each item a fingerprint the store reproduces by reference until the text changes", async () => {
  const f = await fixture()
  const result = await gatherProjectEvidence({ evidence: f.port }, f.request)
  const records = f.store.contextRecords
  if (!records) throw new Error("Missing record reader")
  const kinds = new Set<string>()
  for (const item of result.items) {
    const record = await records.read(item.ref)
    expect(record && contextEvidenceFingerprint(record)).toBe(item.fingerprint)
    kinds.add(item.kind)
  }
  expect([...kinds].sort()).toEqual(["document", "mail", "message"])
  const message = result.items.find((i) => i.kind === "message")
  f.db
    .prepare("UPDATE messages SET text='Harbour launch moved' WHERE account_id=? AND external_id='3'")
    .run(f.accountId)
  const changed = await records.read(message?.ref ?? "")
  expect(changed && contextEvidenceFingerprint(changed)).not.toBe(message?.fingerprint)
  expect(await records.read("msg:telegram/9/9/9")).toBeNull()
  expect(await records.read("document:999999")).toBeNull()
  expect(await records.read("not a ref")).toBeNull()
})

it("reads documents too large to share a page one at a time and moves past one too large to read", async () => {
  const f = await fixture()
  const save = async (path: string, bytes: number) =>
    (
      await f.store.notes.saveFileNote({
        folderId: f.folder.id,
        path,
        title: path,
        text: `Harbour plan ${"x".repeat(bytes)}`,
      })
    ).note
  const medium = [await save("a.md", 30000), await save("b.md", 30000), await save("c.md", 30000)]
  const large = await save("large.md", 95200)
  const huge = await save("huge.md", 300000)
  drainNoteIndex(f.db, stemmerCache())
  const request = {
    ...f.request,
    sources: f.sources.filter((s) => s.kind === "document"),
    project: { name: "Harbour" },
  }
  const result = await gatherProjectEvidence({ evidence: f.port }, request)
  const refs = result.items.map((i) => i.ref)
  for (const note of [...medium, large]) expect(refs).toContain(`document:${note.id}`)
  expect(refs).not.toContain(`document:${huge.id}`)
  expect(result.oversized).toEqual([
    { ref: `document:${huge.id}`, lanes: ["l1"], source: 0, bytes: expect.any(Number) },
  ])
  expect(result.oversized[0]?.bytes).toBeGreaterThan(262144)
  expect(result).toMatchObject({ complete: true, checkpoint: null, stopped: null })
  expect(result.usage.readBytes).toBeLessThan(400000)
})

it("reads a large document on resume when the read budget ran out before its own read", async () => {
  const f = await fixture()
  const { note } = await f.store.notes.saveFileNote({
    folderId: f.folder.id,
    path: "large.md",
    title: "large",
    text: `Harbour plan ${"x".repeat(95200)}`,
  })
  drainNoteIndex(f.db, stemmerCache())
  const request = {
    ...f.request,
    sources: f.sources.filter((s) => s.kind === "document"),
    project: { name: "Harbour" },
    budgets: { maxReads: 1 },
  }
  const first = await gatherProjectEvidence({ evidence: f.port }, request)
  expect(first).toMatchObject({ complete: false, items: [], oversized: [] })
  expect(first.usage.readBytes).toBe(0)
  const next = await gatherProjectEvidence(
    { evidence: f.port },
    { ...request, checkpoint: present(first.checkpoint), budgets: { maxReads: 2 } },
  )
  expect(next.items.map((i) => i.ref)).toContain(`document:${note.id}`)
})
