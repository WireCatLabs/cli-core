import { CliError } from "@wirecat/cli-base"
import { afterEach, expect, it, vi } from "vitest"
import type { ContextEvidenceReader, ContextSource } from "../context/evidence.js"
import { contextEvidenceFixture } from "../testing/context-evidence.js"
import { gatherProjectEvidence, type ProjectSourceFetcher } from "./project-gathering.js"
import { storedMessageNeighbours } from "./project-gathering-around.js"
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
  expect(result.items.find((i) => i.kind === "mail")?.around).toBeUndefined()
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
