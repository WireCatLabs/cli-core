import { CliError } from "@wirecat/cli-base"
import { afterEach, expect, it, vi } from "vitest"
import { type ContextEvidenceReader, type ContextSource, contextEvidenceFingerprint } from "../context/evidence.js"
import { normalize } from "../store/normalize.js"
import { drainNoteIndex } from "../store/sqlite/note-index.js"
import { stemmerCache } from "../store/sqlite/stems.js"
import { historyStartKey } from "../store/store.js"
import type { AccountKey } from "../store/types.js"
import { contextEvidenceFixture } from "../testing/context-evidence.js"
import { chatCoverage } from "./chat-coverage.js"
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

it("reads a large document once when several lanes match it", async () => {
  const f = await fixture()
  const { note } = await f.store.notes.saveFileNote({
    folderId: f.folder.id,
    path: "large.md",
    title: "large",
    text: `Harbour launch plan ${"x".repeat(95200)}`,
  })
  drainNoteIndex(f.db, stemmerCache())
  const request = { ...f.request, sources: f.sources.filter((s) => s.kind === "document") }
  const result = await gatherProjectEvidence({ evidence: f.port }, request)
  expect(result.items.find((i) => i.ref === `document:${note.id}`)?.lanes).toEqual(["l1", "l2"])
  expect(result.usage.readBytes).toBeGreaterThan(95200)
  expect(result.usage.readBytes).toBeLessThan(2 * 95200)
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
    { ...request, checkpoint: present(first.checkpoint), budgets: { maxReads: 3 } },
  )
  expect(next.items.map((i) => i.ref)).toContain(`document:${note.id}`)
})

it("gives a document hit the paragraphs around the one that names the project, in document order", async () => {
  const f = await fixture()
  const { note } = await f.store.notes.saveFileNote({
    folderId: f.folder.id,
    path: "plan.md",
    title: "Plan",
    text: "Intro.\n\nBudget notes.\n\nScope.\n\nThe harbour launch moved to May.\n\nOwners: Ana.\n\nRisks.\n\nAppendix.",
  })
  drainNoteIndex(f.db, stemmerCache())
  const request = {
    ...f.request,
    sources: f.sources.filter((s) => s.kind === "document"),
    project: { name: "Harbour" },
  }
  const result = await gatherProjectEvidence({ evidence: f.port }, request)
  const hit = result.items.find((i) => i.ref === `document:${note.id}`)
  expect(hit?.around?.map((one) => [one.text, one.found])).toEqual([
    ["Budget notes.", false],
    ["Scope.", false],
    ["The harbour launch moved to May.", true],
    ["Owners: Ana.", false],
    ["Risks.", false],
  ])
  expect(hit?.moreMatches).toBe(0)
  expect(hit?.around?.every((one) => one.ref === hit.ref)).toBe(true)
  expect(result.usage.aroundBytes).toBeGreaterThan(0)
  const none = await gatherProjectEvidence({ evidence: f.port }, { ...request, around: { before: 0, after: 0 } })
  expect(none.items.find((i) => i.ref === hit?.ref)?.around).toBeUndefined()
})

it("centres a document hit on its first paragraph that names any lane, not the lane that found it", async () => {
  const f = await fixture()
  const { note } = await f.store.notes.saveFileNote({
    folderId: f.folder.id,
    path: "order.md",
    title: "Order",
    text: "Intro.\n\nThe launch slipped.\n\nBudget.\n\nScope.\n\nHarbour owners met.\n\nRisks.\n\nHarbour again.",
  })
  drainNoteIndex(f.db, stemmerCache())
  const request = {
    ...f.request,
    sources: f.sources.filter((s) => s.kind === "document"),
    around: { before: 1, after: 1 },
  }
  const result = await gatherProjectEvidence({ evidence: f.port }, request)
  const hit = result.items.find((i) => i.ref === `document:${note.id}`)
  expect(hit?.lanes).toEqual(["l1", "l2"])
  expect(hit?.around?.map((one) => [one.text, one.found])).toEqual([
    ["Intro.", false],
    ["The launch slipped.", true],
    ["Budget.", false],
  ])
  expect(hit?.moreMatches).toBe(2)
  const none = await gatherProjectEvidence({ evidence: f.port }, { ...request, around: { before: 0, after: 0 } })
  expect([none.usage.reads, none.usage.readBytes]).toEqual([result.usage.reads, result.usage.readBytes])
})

const linkedChat = (f: Awaited<ReturnType<typeof fixture>>, accountId: number, texts: string[], name = "crew") => {
  const chat = f.db
    .prepare(
      "INSERT INTO chats(account_id,external_id,kind,title,created_at,updated_at,searchable) VALUES(?,?,'group','Crew',0,0,0) RETURNING id",
    )
    .get(accountId, name)
  for (const [n, text] of texts.entries())
    f.db
      .prepare(
        "INSERT INTO messages(chat_id,account_id,external_id,sent_at,text,created_at,updated_at,source) VALUES(?,?,?,?,?,0,0,'history')",
      )
      .run(Number(chat?.id), accountId, `c${n}`, 400 + n, text)
  const account = present(f.db.prepare("SELECT provider,external_id FROM accounts WHERE id=?").get(accountId))
  return { provider: String(account.provider), account: String(account.external_id), chat: name }
}

it("reads a confirmed linked chat whose messages name nothing and labels them linked-chat", async () => {
  const f = await fixture()
  const crew = linkedChat(f, f.accountId, ["Crane arrives Tuesday", "Ok, booked"])
  const outside = linkedChat(f, f.otherId, ["Not ours to read"])
  const missing = { ...crew, chat: "gone" }
  const read = vi.spyOn(f.port, "read")
  const result = await gatherProjectEvidence(
    { evidence: f.port, neighbours: storedMessageNeighbours(f.store.messages) },
    { ...f.request, linkedChats: [crew, outside, missing] },
  )
  expect(result.lanes.slice(2)).toEqual([
    { id: "l3", kinds: ["linked-chat"], query: null, people: [], chat: "chat:example-calendar/AliceExample/crew" },
    { id: "l4", kinds: ["linked-chat"], query: null, people: [], chat: "chat:example-calendar/AliceExample/gone" },
  ])
  expect(result.linkedChats.map((c) => [c.chat, c.account, c.state, c.lane, c.source])).toEqual([
    ["crew", "AliceExample", "in-scope", "l3", 0],
    ["crew", "BobSample", "out-of-scope", null, null],
    ["gone", "AliceExample", "unavailable", "l4", 0],
  ])
  expect(read.mock.calls.some(([r]) => r.source.account === "BobSample")).toBe(false)
  const linked = result.items.filter((i) => i.lanes.includes("l3"))
  expect(linked.map((i) => [i.text, i.context, i.lanes, i.around])).toEqual([
    ["Ok, booked", "linked-chat", ["l3"], undefined],
    ["Crane arrives Tuesday", "linked-chat", ["l3"], undefined],
  ])
  const records = present(f.store.contextRecords)
  const record = present(await records.read(present(linked[0]).ref))
  expect(contextEvidenceFingerprint(record)).toBe(present(linked[0]).fingerprint)
  await expect(
    gatherProjectEvidence({ evidence: f.port }, { ...f.request, linkedChats: [crew, crew] }),
  ).rejects.toMatchObject({ details: { param: "linkedChats" } })
})

it("keeps a literal hit labelled project when a linked chat finds it too", async () => {
  const f = await fixture()
  const message = present(f.sources[0])
  const planning = { provider: message.provider, account: message.account, chat: "planning" }
  const result = await gatherProjectEvidence({ evidence: f.port }, { ...f.request, linkedChats: [planning] })
  const third = present(result.items.find((i) => i.ref.endsWith("/planning/3")))
  expect(third).toMatchObject({ context: "project", lanes: ["l1", "l2", "l3"] })
  expect(result.items.filter((i) => i.context === "linked-chat")).toEqual([])
})

it("resumes a linked chat across pages and refuses a checkpoint whose linked chats changed", async () => {
  const f = await fixture()
  const crew = linkedChat(
    f,
    f.accountId,
    Array.from({ length: 25 }, (_, n) => `Note ${n}`),
  )
  const request = { ...f.request, sources: [present(f.sources[0])], linkedChats: [crew], budgets: { maxReads: 3 } }
  const first = await gatherProjectEvidence({ evidence: f.port }, request)
  expect(first).toMatchObject({ stopped: "reads", complete: false })
  expect(first.items.filter((i) => i.context === "linked-chat")).toHaveLength(20)
  const checkpoint = present(first.checkpoint)
  const second = await gatherProjectEvidence({ evidence: f.port }, { ...request, checkpoint })
  expect(second).toMatchObject({ complete: true, resumed: true })
  const all = [...first.items, ...second.items].filter((i) => i.context === "linked-chat").map((i) => i.ref)
  expect(new Set(all).size).toBe(25)

  for (const linkedChats of [[], [crew, { ...crew, chat: "planning" }]])
    await expect(gatherProjectEvidence({ evidence: f.port }, { ...request, linkedChats, checkpoint })).rejects.toThrow(
      "the project's linked chats changed; start again without --cursor",
    )
})

it("caps each linked chat at its share of a run's items and leaves the rest of a busy chat to the cursor", async () => {
  const f = await fixture()
  const busy = linkedChat(
    f,
    f.accountId,
    Array.from({ length: 60 }, (_, n) => `Busy ${n}`),
    "busy",
  )
  const quiet = [
    linkedChat(f, f.accountId, ["Quiet a", "Quiet b"], "quiet"),
    linkedChat(f, f.accountId, ["Calm"], "calm"),
  ]
  const request = { ...f.request, sources: [present(f.sources[0])], linkedChats: [busy, ...quiet] }
  const read = vi.spyOn(f.port, "read")
  const runs = [await gatherProjectEvidence({ evidence: f.port }, request)]
  const chatsRead = read.mock.calls.flatMap(([r]) => (r.chat ? [r.chat] : []))
  expect(chatsRead.slice(0, 3)).toEqual(["busy", "quiet", "calm"])
  while (runs.at(-1)?.checkpoint)
    runs.push(
      await gatherProjectEvidence({ evidence: f.port }, { ...request, checkpoint: present(runs.at(-1)?.checkpoint) }),
    )

  const linkedCounts = (run: (typeof runs)[number]) => run.linkedChats.map((c) => [c.chat, c.items, c.capped])
  expect(runs.map(linkedCounts)).toEqual([
    [
      ["busy", 25, true],
      ["quiet", 2, false],
      ["calm", 1, false],
    ],
    [
      ["busy", 35, false],
      ["quiet", 0, false],
      ["calm", 0, false],
    ],
  ])
  expect(runs.map((r) => [r.complete, r.stopped])).toEqual([
    [false, null],
    [true, null],
  ])
  const busyRefs = runs.flatMap((r) => r.items.filter((i) => i.ref.includes("/busy/")).map((i) => i.ref))
  expect(busyRefs).toHaveLength(60)
  expect(new Set(busyRefs).size).toBe(60)
  expect(present(runs[0]).items.filter((i) => i.context === "project").length).toBeGreaterThan(0)
})

it("gives a busy chat left alone the whole run once the quiet chats and word lanes finish", async () => {
  const f = await fixture()
  const busy = linkedChat(
    f,
    f.accountId,
    Array.from({ length: 150 }, (_, n) => `Busy ${n}`),
    "busy",
  )
  const quiet = linkedChat(f, f.accountId, ["Quiet"], "quiet")
  const request = { ...f.request, sources: [present(f.sources[0])], linkedChats: [busy, quiet] }
  const first = await gatherProjectEvidence({ evidence: f.port }, request)
  const second = await gatherProjectEvidence(
    { evidence: f.port },
    { ...request, checkpoint: present(first.checkpoint) },
  )

  const busyItems = (run: typeof first) => run.items.filter((i) => i.ref.includes("/busy/")).length
  expect([busyItems(first), busyItems(second)]).toEqual([33, 100])
  expect(second.items.filter((i) => i.context !== "linked-chat")).toEqual([])
})

it("keeps the fingerprint and checkpoint of a run without linked chats", async () => {
  const f = await fixture()
  const budgeted = { ...f.request, budgets: { maxReads: 3 } }
  const first = await gatherProjectEvidence({ evidence: f.port }, budgeted)
  const withEmpty = await gatherProjectEvidence({ evidence: f.port }, { ...budgeted, linkedChats: [] })
  expect(withEmpty.fingerprint).toBe(first.fingerprint)
  const decoded = JSON.parse(Buffer.from(present(first.checkpoint), "base64url").toString("utf8"))
  expect(decoded).toMatchObject({ version: 1 })
  expect(decoded).not.toHaveProperty("linkedChats")
  const resumed = await gatherProjectEvidence(
    { evidence: f.port },
    { ...f.request, checkpoint: present(first.checkpoint) },
  )
  expect(resumed).toMatchObject({ resumed: true, complete: true, linkedChats: [] })
  await expect(
    gatherProjectEvidence(
      { evidence: f.port },
      { ...f.request, linkedChats: [linkedChat(f, f.accountId, ["x"])], checkpoint: present(first.checkpoint) },
    ),
  ).rejects.toThrow("linked chats changed")
})

const sentBy = (f: Awaited<ReturnType<typeof fixture>>, accountId: number, sender: string, texts: string[]) => {
  const identity = present(
    f.db
      .prepare(
        "INSERT INTO identities(provider,external_id,name,created_at,updated_at) VALUES('example-calendar',?,'Степа Stefan Grachev AVITO M A',0,0) ON CONFLICT DO UPDATE SET name=name RETURNING id",
      )
      .get(sender),
  )
  const chat = present(
    f.db
      .prepare(
        "INSERT INTO chats(account_id,external_id,kind,title,created_at,updated_at) VALUES(?,'dm','private','Stepa',0,0) RETURNING id",
      )
      .get(accountId),
  )
  for (const [n, text] of texts.entries())
    f.db
      .prepare(
        "INSERT INTO messages(chat_id,account_id,external_id,sender_identity_id,sent_at,text,normalized_text,normalizer_version,created_at,updated_at,source) VALUES(?,?,?,?,?,?,?,1,0,0,'history')",
      )
      .run(Number(chat.id), accountId, `s${n}`, Number(identity.id), 500 + n, text, normalize(text))
}

it("reads what a person's identities wrote, though it names nothing, only in the selected accounts", async () => {
  const f = await fixture()
  sentBy(f, f.accountId, "u7", ["Booked it for Tuesday"])
  sentBy(f, f.otherId, "u7", ["Not ours to read"])
  const address = present(
    f.db
      .prepare(
        "INSERT INTO identities(provider,external_id,created_at,updated_at) VALUES('email','stepa@example.com',0,0) RETURNING id",
      )
      .get(),
  )
  f.db
    .prepare(
      "INSERT INTO emails(id,account_id,email_thread_id,external_id,subject,body_text,from_identity_id,sent_at,created_at,updated_at) VALUES(2,?,1,'reply','Re: dates','See attached',?,600,0,0)",
    )
    .run(f.mailId, Number(address.id))
  const read = vi.spyOn(f.port, "read")
  const senders = [
    { provider: "example-calendar", id: "u7" },
    { provider: "telegram", id: "u7" },
    { provider: "email", id: "stepa@example.com" },
  ]
  const result = await gatherProjectEvidence(
    { evidence: f.port, neighbours: storedMessageNeighbours(f.store.messages) },
    { ...f.request, project: { name: "Zeppelin" }, people: [{ reference: "person:7", senders }] },
  )
  expect(result.lanes).toEqual([
    { id: "l1", kinds: ["project"], query: "Zeppelin", people: [] },
    { id: "l2", kinds: ["sender"], query: null, people: ["person:7"], senders },
  ])
  expect(result.units.filter((u) => u.lane === "l2").map((u) => u.source)).toEqual([0, 1])
  expect(result.items.map((i) => [i.kind, i.text, i.context, i.lanes])).toEqual([
    ["message", "Booked it for Tuesday", "sender", ["l2"]],
    ["mail", "See attached", "sender", ["l2"]],
  ])
  expect(read.mock.calls.some(([r]) => r.source.account === "BobSample")).toBe(false)
  expect(read.mock.calls.filter(([r]) => r.senders).map(([r]) => [r.source.kind, r.senders])).toEqual([
    ["message", ["u7"]],
    ["mail", ["stepa@example.com"]],
  ])
})

it("keeps a project hit labelled project when its sender lane finds it too", async () => {
  const f = await fixture()
  sentBy(f, f.accountId, "u7", ["Harbour crane booked"])
  const result = await gatherProjectEvidence(
    { evidence: f.port },
    { ...f.request, people: [{ reference: "person:7", senders: [{ provider: "example-calendar", id: "u7" }] }] },
  )
  expect(result.items.find((i) => i.text === "Harbour crane booked")).toMatchObject({
    context: "project",
    lanes: ["l1", "l3"],
  })
})

it("resumes a sender lane across pages", async () => {
  const f = await fixture()
  sentBy(
    f,
    f.accountId,
    "u7",
    Array.from({ length: 25 }, (_, n) => `Note ${n}`),
  )
  const request = {
    ...f.request,
    sources: [present(f.sources[0])],
    people: [{ reference: "person:7", senders: [{ provider: "example-calendar", id: "u7" }] }],
    budgets: { maxReads: 3 },
  }
  const first = await gatherProjectEvidence({ evidence: f.port }, request)
  expect(first).toMatchObject({ stopped: "reads", complete: false })
  const second = await gatherProjectEvidence(
    { evidence: f.port },
    { ...request, checkpoint: present(first.checkpoint) },
  )
  expect(second).toMatchObject({ complete: true, resumed: true })
  const sent = [...first.items, ...second.items].filter((i) => i.context === "sender").map((i) => i.ref)
  expect(new Set(sent).size).toBe(25)
})

it("keeps the fingerprint a person's name lane had before sender lanes, so its checkpoints still resume", async () => {
  const f = await fixture()
  const request: ProjectGatheringRequest = {
    project: { name: "Harbour" },
    people: [{ name: "Stepa", reference: "person:7" }],
    sources: [present(f.sources[0])],
    scope: "explicit",
    after: 0,
    before: 10000,
  }
  const result = await gatherProjectEvidence({ evidence: f.port }, request)
  expect(result.fingerprint).toBe("d5cc956d118b4c9f935f0db983e1b468fbe76c681ed412e30b7233c06ee16aa7")
  await expect(
    gatherProjectEvidence({ evidence: f.port }, { ...request, people: [{ senders: [{ provider: "x", id: "1" }] }] }),
  ).rejects.toMatchObject({ details: { param: "people.0.reference" } })
})

it("counts who wrote the run's items by stored person, joining a person's identities and leaving out the owner", async () => {
  const f = await fixture()
  const row = (sql: string, ...params: (string | number)[]) => present(f.db.prepare(sql).get(...params))
  const identity = (provider: string, id: string, name: string | null) =>
    Number(
      row(
        "INSERT INTO identities(provider,external_id,name,created_at,updated_at) VALUES(?,?,?,0,0) RETURNING id",
        provider,
        id,
        name ?? id,
      ).id,
    )
  const link = (identityId: number, personId: number) =>
    f.db
      .prepare(
        "INSERT INTO identity_links(identity_id,person_id,method,confidence,created_at,author,updated_at) VALUES(?,?,'manual',1,0,'owner',0)",
      )
      .run(identityId, personId)
  const stepa = Number(row("INSERT INTO persons(name,created_at,updated_at) VALUES('Степа',0,0) RETURNING id").id)
  const owner = Number(row("SELECT id FROM persons WHERE owner=1").id)
  const account = String(row("SELECT external_id FROM accounts WHERE id=?", f.accountId).external_id)
  const u7 = identity("example-calendar", "u7", "Stefan")
  const address = identity("email", "stepa@example.com", null)
  const u8 = identity("example-calendar", "u8", "Bob")
  const mine = identity("example-calendar", "u9", "Me elsewhere")
  const self = identity("example-calendar", account, "Me")
  link(u7, stepa)
  link(address, stepa)
  link(mine, owner)
  const chat = Number(
    row(
      "INSERT INTO chats(account_id,external_id,kind,title,created_at,updated_at) VALUES(?,'dm','group','Crew',0,0) RETURNING id",
      f.accountId,
    ).id,
  )
  for (const [n, [sender, text]] of (
    [
      [u7, "Harbour crane booked"],
      [u7, "Harbour berth moved"],
      [u8, "Harbour lunch"],
      [mine, "Harbour from my phone"],
      [self, "Harbour from me"],
    ] as const
  ).entries())
    f.db
      .prepare(
        "INSERT INTO messages(chat_id,account_id,external_id,sender_identity_id,sent_at,text,normalized_text,normalizer_version,created_at,updated_at,source) VALUES(?,?,?,?,?,?,?,1,0,0,'history')",
      )
      .run(chat, f.accountId, `p${n}`, sender, 400 + n, text, normalize(text))
  f.db
    .prepare(
      "INSERT INTO emails(id,account_id,email_thread_id,external_id,subject,body_text,from_identity_id,sent_at,created_at,updated_at) VALUES(2,?,1,'dates','Harbour dates','Tuesday',?,600,0,0)",
    )
    .run(f.mailId, address)
  f.db.prepare("INSERT INTO email_words(rowid,normalized_text,scope) VALUES(2,'harbour dates tuesday','')").run()
  f.db.exec("DELETE FROM email_index_pending")

  const result = await gatherProjectEvidence({ evidence: f.port }, { ...f.request, project: { name: "Harbour" } })

  expect(result.items).toHaveLength(11)
  expect(result.items.some((i) => "sender" in i)).toBe(false)
  expect(result.people).toEqual([
    {
      person: `person:${stepa}`,
      name: "Степа",
      identities: [
        { provider: "example-calendar", account, id: "u7" },
        { provider: "email", account: "example-mail", id: "stepa@example.com" },
      ],
      items: 3,
      contexts: { project: 3 },
    },
    {
      person: null,
      name: "Bob",
      identities: [{ provider: "example-calendar", account, id: "u8" }],
      items: 1,
      contexts: { project: 1 },
    },
  ])
  expect(result.peopleOmitted).toBe(0)
})

const coveragePort = (f: Awaited<ReturnType<typeof fixture>>) => (account: AccountKey, chatIds: string[]) =>
  chatCoverage(f.store, account, chatIds)

it("reads the first page of every linked chat even when a busy word lane fills the item budget", async () => {
  const f = await fixture()
  const insert = f.db.prepare(
    "INSERT INTO messages(chat_id,account_id,external_id,sent_at,text,normalized_text,normalizer_version,created_at,updated_at,source) VALUES(?,?,?,?,?,?,1,0,0,'history')",
  )
  for (let n = 0; n < 300; n++)
    insert.run(f.accountId, f.accountId, `w${n}`, 500 + n, `Harbour hit ${n}`, normalize(`Harbour hit ${n}`))
  const chats = Array.from({ length: 12 }, (_, n) => linkedChat(f, f.accountId, [`Crew ${n} says hi`], `crew${n}`))
  const result = await gatherProjectEvidence(
    { evidence: f.port },
    { ...f.request, sources: [present(f.sources[0])], linkedChats: chats, budgets: { maxItems: 100 } },
  )
  expect(result.linkedChats.filter((c) => c.state === "pending")).toEqual([])
  expect(result.linkedChats.filter((c) => c.state === "in-scope" && c.items === 0 && !c.capped)).toEqual([])
})

it("marks a linked chat the run stopped before reaching pending, without an item count", async () => {
  const f = await fixture()
  const chats = ["first", "second", "third"].map((name) => linkedChat(f, f.accountId, [`${name} says hi`], name))
  const request = { ...f.request, sources: [present(f.sources[0])], linkedChats: chats, budgets: { maxReads: 3 } }
  const run = await gatherProjectEvidence({ evidence: f.port, coverage: coveragePort(f) }, request)
  expect(run.linkedChats.map((c) => [c.chat, c.state])).toEqual([
    ["first", "in-scope"],
    ["second", "pending"],
    ["third", "pending"],
  ])
  expect(run.linkedChats[1]).not.toHaveProperty("items")
  const done = await gatherProjectEvidence(
    { evidence: f.port },
    { ...request, budgets: undefined, checkpoint: present(run.checkpoint) },
  )
  expect(done.linkedChats.map((c) => c.state)).toEqual(["in-scope", "in-scope", "in-scope"])
})

it("says per linked chat what the store holds, and rolls the run up without calling unknown complete", async () => {
  const f = await fixture()
  const account = { provider: "example-calendar", account: "AliceExample" }
  const [partial, whole, never] = [
    linkedChat(f, f.accountId, ["a1", "a2", "a3", "a4"], "partial"),
    linkedChat(f, f.accountId, ["b1", "b2"], "whole"),
    { ...linkedChat(f, f.accountId, [], "never") },
  ]
  await f.store.sync.markRange(account, "partial", 2, 4)
  await f.store.sync.markRange(account, "whole", 1, 2)
  await f.store.sync.setSyncState(account, historyStartKey("whole"), "1")
  const request = { ...f.request, sources: [present(f.sources[0])] }
  const ports = { evidence: f.port, coverage: coveragePort(f) }

  const result = await gatherProjectEvidence(ports, { ...request, linkedChats: [partial, whole, never] })
  const rows = result.linkedChats.map((c) => [c.chat, c.completeness?.state, c.held?.messages])
  expect(rows).toEqual([
    ["partial", "partial", 4],
    ["whole", "complete", 2],
    ["never", "unknown", 0],
  ])
  expect(result).toMatchObject({ complete: true, completeness: "partial" })
  expect((await gatherProjectEvidence(ports, { ...request, linkedChats: [whole] })).completeness).toBe("complete")
  expect((await gatherProjectEvidence(ports, { ...request, linkedChats: [never] })).completeness).toBe("unknown")
  expect((await gatherProjectEvidence({ evidence: f.port }, { ...request, linkedChats: [whole] })).completeness).toBe(
    "unknown",
  )
})

it("takes a linked chat's title from its chat row, and gives a chat the store lacks none", async () => {
  const f = await fixture()
  const empty = linkedChat(f, f.accountId, [], "empty")
  const absent = { ...empty, chat: "nowhere" }
  const request = {
    ...f.request,
    sources: [present(f.sources[0])],
    linkedChats: [empty, absent],
    budgets: { maxReads: 2 },
  }
  const run = await gatherProjectEvidence({ evidence: f.port, coverage: coveragePort(f) }, request)
  expect(run.linkedChats.map((c) => [c.chat, c.state, c.title, c.completeness?.state, c.held?.messages])).toEqual([
    ["empty", "pending", "Crew", "unknown", 0],
    ["nowhere", "pending", null, "unknown", 0],
  ])
})
