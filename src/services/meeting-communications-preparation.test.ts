import { CliError, projectFields } from "@wirecat/cli-base"
import { afterEach, expect, it, vi } from "vitest"
import { meetingPreparationAnswer } from "../cli/meeting-preparation-answer.js"
import type { ContextEvidenceReader } from "../context/evidence.js"
import { normalize } from "../store/normalize.js"
import { contextEvidenceFixture } from "../testing/context-evidence.js"
import type { MeetingCommunicationsPort, MeetingCommunicationsRequest } from "./meeting-communications-types.js"
import { createMeetingPreparationService } from "./meeting-preparation.js"

const present = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Missing fixture value")
  return value
}
const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const f of handles.splice(0)) await f.close()
})
const setup = async (provider = "example-calendar") => {
  const f = await contextEvidenceFixture(provider)
  handles.push(f)
  const selections = Object.entries(f.sources).map(([id, source]) => ({ id, source }))
  const binding: MeetingCommunicationsPort = { selections, reader: f.port }
  const service = (communications: MeetingCommunicationsPort | undefined = binding) =>
    createMeetingPreparationService(f.key, f.accountId, {
      meetings: f.store.meetings,
      upcoming: f.upcoming,
      communications,
    })
  const request = {
    after: 10000,
    until: 20000,
    historyAfter: 0,
    communications: { sources: selections.map(({ id }) => ({ id })), query: "launch" },
  }
  return { ...f, selections, binding, service, request }
}

it.each(["example-calendar", "invented-scheduler"])(
  "assembles all native sources for %s without writes, identity inference or legacy drift",
  async (provider) => {
    const f = await setup(provider)
    const legacy = await f.service(undefined).prepare("example-series", { ...f.request, communications: undefined })
    expect(legacy).not.toHaveProperty("communications")
    const before = f.db.prepare("SELECT total_changes() AS n").get()
    f.db.exec("PRAGMA query_only=ON")
    const result = await f.service().prepare("example-series", {
      ...f.request,
      communications: { ...f.request.communications, sources: [...f.request.communications.sources].reverse() },
    })
    expect(result.communications?.items.map((i) => i.selectionId)).toEqual([
      "message",
      "document",
      "mail",
      "message",
      "message",
    ])
    expect(result.communications?.items[0]?.ref).toContain(`msg:${provider}/AliceExample/planning/3`)
    expect(result.items.flatMap((i) => i.evidence.items.map((cue) => cue.fingerprint))).toEqual(
      legacy.items.flatMap((i) => i.evidence.items.map((cue) => cue.fingerprint)),
    )
    const withoutPort = createMeetingPreparationService(f.key, f.accountId, {
      meetings: f.store.meetings,
      upcoming: f.upcoming,
    })
    expect(await withoutPort.prepare("example-series", { ...f.request, communications: undefined })).toEqual(legacy)
    expect(result.communications).toMatchObject({
      window: { after: 0, before: 10000 },
      readUsage: { reads: 3, reservedBytes: 0 },
      sources: [{ source: f.sources.message }, { source: f.sources.document }, { source: f.sources.mail }],
    })
    expect(result.coverage.unqueried).toContain("other-project-nonmeeting-context")
    expect(result.communications?.items.some((i) => i.account === "BobSample")).toBe(false)
    expect(f.db.prepare("SELECT total_changes() AS n").get()).toEqual(before)
    const answer = meetingPreparationAnswer(result)
    expect(answer.meta?.complete).toBe(true)
    expect(answer.item.communications?.items[0]?.at).toBe("1970-01-01T00:00:00.300Z")
  },
)

it("rejects capability, grants, selectors, windows, words and cursors before upcoming or content reads", async () => {
  const f = await setup()
  const read = vi.fn(f.port.read.bind(f.port)),
    account = vi.spyOn(f.store.meetings, "account")
  const service = f.service({ ...f.binding, reader: { read } })
  const cases = [
    { sources: [{ id: "foreign" }], query: "launch" },
    { sources: [], query: "launch" },
    { sources: [{ id: "message" }, { id: "message" }], query: "launch" },
    { ...f.request.communications, chatIds: ["planning"] },
    { ...f.request.communications, query: "?" },
    { ...f.request.communications, query: "word ".repeat(17) },
    { ...f.request.communications, before: 10001 },
    { ...f.request.communications, after: 10000 },
    { ...f.request.communications, after: -1 },
    { sources: [{ id: "message", cursor: "not-json" }], query: "launch" },
  ]
  for (const communications of cases)
    await expect(
      service.prepare("example-series", { ...f.request, communications } as typeof f.request),
    ).rejects.toMatchObject({ code: "validation_error" })
  const unsupported = createMeetingPreparationService(f.key, f.accountId, {
    meetings: f.store.meetings,
    upcoming: f.upcoming,
  })
  await expect(unsupported.prepare("example-series", f.request)).rejects.toMatchObject({ code: "configuration_error" })
  expect(read).not.toHaveBeenCalled()
  expect(account).not.toHaveBeenCalled()
  expect(f.reads()).toBe(0)
})

it("captures grants and the bound reader rather than following later host mutations", async () => {
  const f = await setup()
  const service = f.service()
  present(f.selections[0]).id = "replaced"
  present(f.selections[0]).source.account = "BobSample"
  f.binding.reader = {
    read: async () => {
      throw new Error("wrong reader")
    },
  }
  const result = await service.prepare("example-series", f.request)
  expect(result.communications?.sources[0]?.selectionId).toBe("message")
  expect(result.communications?.items[0]?.account).toBe("AliceExample")
})

it("reports failed, pending and byte-refused sources without losing successful evidence", async () => {
  const f = await setup()
  const reader: ContextEvidenceReader = {
    async read(req) {
      if (req.source.kind === "document") throw new CliError("not_found", "removed")
      if (req.source.kind === "mail")
        throw new CliError("validation_error", "oversized", { reason: "context.read-budget" })
      return f.port.read(req)
    },
  }
  const answer = meetingPreparationAnswer(
    await f.service({ ...f.binding, reader }).prepare("example-series", f.request),
  )
  expect(answer).toMatchObject({
    meta: {
      complete: false,
      issues: [
        { code: "not_found", source: "document" },
        { code: "validation_error", source: "mail" },
      ],
    },
    item: {
      communications: {
        coverage: {
          read_usage: { reads: 3, reserved_bytes: 0 },
          sources: [
            { state: "searched" },
            { state: "unavailable", read_bytes: null },
            { state: "read-limited", restart_required: true },
          ],
        },
      },
    },
  })
  expect(projectFields(answer, ["communications.items.ref"])).toMatchObject({
    meta: answer.meta,
    item: { communications: { coverage: answer.item.communications?.coverage } },
  })
  f.db
    .prepare("INSERT OR REPLACE INTO document_index_pending(indexable_type,id) VALUES('document',?)")
    .run(Number(f.doc.id))
  const pending = meetingPreparationAnswer(await f.service().prepare("example-series", f.request))
  expect(pending).toMatchObject({
    meta: { complete: false, issues: [{ code: "configuration_error", source: "document" }] },
  })
  expect(pending.item.communications?.coverage.sources.find((s) => s.selection_id === "document")?.index).toBe(
    "pending",
  )
})

it("refuses foreign adapter results and cancellation instead of returning partial success", async () => {
  const f = await setup()
  const wrong = f.service({
    ...f.binding,
    reader: {
      async read(req) {
        const page = await f.port.read(req)
        page.source.account = "foreign"
        return page
      },
    },
  })
  await expect(wrong.prepare("example-series", f.request)).rejects.toMatchObject({ code: "invalid_response" })
  const controller = new AbortController()
  const cancelled = f.service({
    ...f.binding,
    reader: {
      async read(req) {
        controller.abort()
        return f.port.read(req)
      },
    },
  })
  await expect(cancelled.prepare("example-series", { ...f.request, signal: controller.signal })).rejects.toMatchObject({
    code: "cancelled",
  })
})

it("round-robins within a total quota, retains scoped continuation and rejects changed selections", async () => {
  const f = await setup()
  for (let n = 4; n <= 14; n++)
    f.db
      .prepare(
        "INSERT INTO messages(chat_id,account_id,external_id,sent_at,text,normalized_text,normalizer_version,created_at,updated_at,source) VALUES(?,?,?,?,?,?,1,0,0,'history')",
      )
      .run(f.accountId, f.accountId, String(n), 100 + n, "Launch next", "launch next")
  const service = f.service(),
    first = await service.prepare("example-series", f.request)
  const cursor = first.communications?.sources[0]?.nextCursor
  expect(cursor).toBeTypeOf("string")
  const communications: MeetingCommunicationsRequest = {
    query: "launch",
    sources: [{ id: "message", cursor: cursor ?? undefined }],
  }
  const next = await service.prepare("example-series", { ...f.request, communications })
  expect(next.communications?.items).toHaveLength(4)
  expect(
    new Set(
      [...present(first.communications).items, ...present(next.communications).items]
        .filter((i) => i.selectionId === "message")
        .map((i) => i.ref),
    ).size,
  ).toBe(14)
  await expect(
    service.prepare("example-series", { ...f.request, communications: { ...communications, query: "different" } }),
  ).rejects.toMatchObject({ code: "validation_error" })
})

it("caps the round-robin merge and marks discarded rows for restart without deduplicating equal text across accounts", async () => {
  const f = await setup()
  for (const account of [f.accountId, f.otherId])
    for (let n = 4; n <= 14; n++)
      f.db
        .prepare(
          "INSERT INTO messages(chat_id,account_id,external_id,sent_at,text,normalized_text,normalizer_version,created_at,updated_at,source) VALUES(?,?,?,?,?,?,1,0,0,'history')",
        )
        .run(account, account, String(n), 100 + n, "Launch next", "launch next")
  const selections = [
    ...f.selections,
    { id: "other-chat", source: { ...f.sources.message, accountId: f.otherId, account: "BobSample" } },
  ]
  const result = await f.service({ ...f.binding, selections }).prepare("example-series", {
    ...f.request,
    communications: { query: "launch", sources: selections.map(({ id }) => ({ id })) },
  })
  expect(result.communications?.items).toHaveLength(20)
  expect(result.communications?.items.some((i) => i.account === "BobSample")).toBe(true)
  expect(result.communications?.sources.filter((s) => s.outputLimited)).toHaveLength(2)
  expect(
    result.communications?.sources
      .filter((s) => s.outputLimited)
      .every((s) => s.restartRequired && s.nextCursor === null),
  ).toBe(true)
})

it("deduplicates repeated canonical references within one source without changing its continuation", async () => {
  const f = await setup()
  const reader: ContextEvidenceReader = {
    async read(request) {
      const page = await f.port.read(request)
      if (request.source.kind === "message") {
        page.items.push(...page.items)
        page.readBytes *= 2
      }
      return page
    },
  }
  const result = await f.service({ ...f.binding, reader }).prepare("example-series", f.request)
  expect(result.communications?.items.filter((i) => i.selectionId === "message")).toHaveLength(3)
  expect(result.communications?.sources[0]?.nextCursor).toBeNull()
})

it("centers bounded excerpts on literal short words and folded Unicode matches", async () => {
  const f = await setup()
  for (const [query, word] of [
    ["OR", "OR"],
    ["cafe", "café"],
    ["вега", "ВЕГА"],
  ] as const) {
    const text = `${"padding ".repeat(200)}${word}${" after ".repeat(200)}`
    f.db
      .prepare("UPDATE messages SET text=?, normalized_text=? WHERE account_id=?")
      .run(text, normalize(text), f.accountId)
    const result = await f
      .service()
      .prepare("example-series", { ...f.request, communications: { query, sources: [{ id: "message" }] } })
    const items = result.communications?.items ?? []
    expect(items).toHaveLength(3)
    expect(items.every((i) => i.text.includes(word) && i.textTruncated && Buffer.byteLength(i.text) <= 1024)).toBe(true)
  }
})

it("refuses malformed or duplicated host grants before using them", async () => {
  const f = await setup()
  for (const selections of [
    [],
    Array.from({ length: 9 }, () => present(f.selections[0])),
    [present(f.selections[0]), present(f.selections[0])],
    [present(f.selections[0]), { ...present(f.selections[0]), id: "alias" }],
    [{ ...present(f.selections[0]), id: "bad/ID" }],
  ])
    expect(() => f.service({ ...f.binding, selections })).toThrow()
  expect(() => f.service({ ...f.binding, reader: null as unknown as ContextEvidenceReader })).toThrow()
  expect(f.reads()).toBe(0)
})

it("does not call a short multi-line message cut", async () => {
  const f = await setup()
  f.db.prepare("UPDATE emails SET body_text=? WHERE id=1").run("Launch agreement\n\n  signed on Monday\n")
  f.db.exec("DELETE FROM email_index_pending")
  const result = await f.service().prepare("example-series", {
    ...f.request,
    communications: { ...f.request.communications, sources: [{ id: "mail" }] },
  })
  expect(result.communications?.items).toMatchObject([
    { selectionId: "mail", text: "Launch agreement signed on Monday", textTruncated: false },
  ])
  expect(result.coverage.outputLimited).toBe(false)
})
