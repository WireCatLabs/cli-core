import { afterEach, describe, expect, it, vi } from "vitest"
import { meetingPreparationAnswer } from "../cli/meeting-preparation-answer.js"
import { type MeetingRelatedHistoryRequest, validateMeetingRelatedHistory } from "../meetings/index.js"
import { preparationFixture } from "../testing/meeting-preparation.js"
import { createMeetingPreparationService } from "./meeting-preparation.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})
const fixture = async () => {
  const f = await preparationFixture()
  handles.push(f)
  const add = async (
    name: string,
    options: { person?: boolean; project?: boolean; accountId?: number; time?: number; proposed?: boolean } = {},
  ) => {
    const input = { ...structuredClone(f.input), participants: structuredClone([...f.input.participants]) }
    if (!input.meeting.series) throw new Error("Missing invented series")
    input.meeting.externalId = name
    input.meeting.accountId = options.accountId ?? f.accountId
    input.meeting.startedAt = options.time ?? 3000
    input.meeting.series = { ...input.meeting.series, externalId: name, title: name }
    if (!options.person) {
      input.participants = []
      for (const line of input.chat) line.senderParticipantPosition = null
      for (const transcript of input.transcripts)
        for (const row of transcript.rows) row.speakerParticipantPosition = null
    }
    const saved = await f.store.meetings.saveMeeting(input)
    if (options.project)
      await f.store.knowledge.linkMeetingProject(
        { ...f.key, account: options.accountId === f.otherId ? "BobSample" : f.key.account },
        String(saved.meeting.id),
        f.project.id,
        options.proposed ? { by: "agent" } : undefined,
      )
    return saved
  }
  const request: MeetingRelatedHistoryRequest = {
    accountId: f.accountId,
    seriesId: f.context.seriesId,
    anchorIds: [f.saved.meeting.id],
    after: 0,
    before: 10000,
  }
  const ports = { meetings: f.store.meetings, upcoming: f.upcoming }
  return {
    ...f,
    add,
    relatedRequest: request,
    ports,
    service: createMeetingPreparationService(f.key, f.accountId, ports),
  }
}

describe("meeting preparation across series", () => {
  it("includes cited same-account history through explicit people and confirmed projects, without writes", async () => {
    const f = await fixture()
    const person = await f.add("person-context", { person: true })
    const project = await f.add("project-context", { project: true, time: 4000 })
    await f.add("unrelated")
    await f.add("proposed-only", { project: true, proposed: true })
    await f.add("foreign", { person: true, project: true, accountId: f.otherId })
    await f.add("future", { person: true, time: 10000 })
    const snapshot = () =>
      Object.fromEntries(
        ["meetings", "links", "identity_links", "facts", "tasks", "meeting_index_pending"].map((table) => [
          table,
          f.db.prepare(`SELECT * FROM ${table}`).all(),
        ]),
      )
    const before = snapshot()
    const packet = await f.service.prepare("example-series", f.request)
    expect(packet.related.items.map((item) => [item.meeting.id, item.sharedPerson, item.sharedProject])).toEqual([
      [project.meeting.id, false, true],
      [person.meeting.id, true, false],
    ])
    expect(packet.related.anchors).toEqual([f.reference])
    expect(packet.related.hasMore).toBe(false)
    for (const item of packet.related.items)
      expect(item.evidence.items[0]?.reference).toMatch(new RegExp(`^meeting:${f.accountId}/${item.meeting.id}/`))
    expect(packet.coverage.unqueried).toEqual([
      "person-nonmeeting-context",
      "project-nonmeeting-context",
      "project-alias-candidates",
    ])
    const answer = meetingPreparationAnswer(packet)
    expect(answer.item.related.items[0]).toMatchObject({
      shared_project: true,
      shared_person: false,
      meeting: { id: String(project.meeting.id), started_at: "1970-01-01T00:00:04.000Z" },
    })
    expect(JSON.stringify(answer.item)).not.toContain("sharedPerson")
    expect(snapshot()).toEqual(before)
  })

  it("deduplicates both association paths and retains deterministic lookahead", async () => {
    const f = await fixture()
    const first = await f.add("first", { person: true, project: true })
    const second = await f.add("second", { person: true, project: true })
    const page = await f.store.meetings.relatedHistory({ ...f.relatedRequest, limit: 1 })
    expect(page.items).toMatchObject([{ meeting: { id: second.meeting.id }, sharedPerson: true, sharedProject: true }])
    expect(page.hasMore).toBe(true)
    const packet = await f.service.prepare("example-series", { ...f.request, meetings: 1 })
    expect(packet.related.items.map((item) => item.meeting.id)).toEqual([second.meeting.id])
    expect(packet.related.hasMore).toBe(true)
    expect(first.meeting.id).not.toBe(second.meeting.id)
  })

  it("does not infer people from names, or projects from matching words", async () => {
    const f = await fixture()
    const named = structuredClone(f.input)
    if (!named.meeting.series) throw new Error("Missing invented series")
    named.meeting.externalId = "same-name"
    named.meeting.series = { ...named.meeting.series, externalId: "same-name" }
    named.meeting.title = f.project.name
    named.participants[0].identity.externalId = "unlinked-same-display-name"
    named.participants[0].identity.associatePerson = false
    await f.store.meetings.saveMeeting(named)
    expect((await f.service.prepare("example-series", f.request)).related.items).toEqual([])
  })

  it("excludes deleted records, invalid anchors and out-of-window anchors", async () => {
    const f = await fixture()
    const saved = await f.add("deleted", { person: true, project: true })
    for (const sql of [
      "UPDATE meetings SET deleted_at=5000 WHERE id=?",
      "UPDATE meeting_series SET deleted_at=5000 WHERE id=(SELECT meeting_series_id FROM meetings WHERE id=?)",
    ]) {
      f.db.prepare(sql).run(saved.meeting.id)
      expect((await f.store.meetings.relatedHistory(f.relatedRequest)).items).toEqual([])
      f.db.prepare("UPDATE meetings SET deleted_at=NULL").run()
    }
    f.db.prepare("UPDATE meeting_series SET deleted_at=NULL").run()
    if (!saved.series) throw new Error("Missing invented series")
    for (const patch of [{ accountId: f.otherId }, { seriesId: saved.series.id }, { after: 2000 }, { anchorIds: [] }])
      expect((await f.store.meetings.relatedHistory({ ...f.relatedRequest, ...patch })).items).toEqual([])
  })

  it("bounds stored UTF-8 text before hydration, including lookahead", async () => {
    const f = await fixture()
    await f.add("first", { person: true, time: 4000 })
    const second = await f.add("large-lookahead", { person: true })
    f.db.prepare("UPDATE meetings SET title=? WHERE id=?").run("界".repeat(1000), second.meeting.id)
    await expect(
      f.store.meetings.relatedHistory({ ...f.relatedRequest, limit: 1, maxReadBytes: 500 }),
    ).rejects.toMatchObject({ code: "validation_error" })
  })

  it("keeps exact-series context when related evidence exceeds the packet budget", async () => {
    const f = await fixture()
    const saved = await f.add("large-related", { person: true })
    f.db.prepare("UPDATE meetings SET title=? WHERE id=?").run("界".repeat(2000), saved.meeting.id)
    const packet = await f.service.prepare("example-series", { ...f.request, bytes: 8192 })
    expect(packet.items).toHaveLength(1)
    expect(packet.related.items).toHaveLength(0)
    expect(packet.related.outputLimited).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(meetingPreparationAnswer(packet).item))).toBeLessThanOrEqual(8192)
  })

  it("skips changed related revisions and propagates cancellation", async () => {
    const f = await fixture()
    const saved = await f.add("changed", { person: true })
    const relatedHistory = vi.fn(async (...args: Parameters<typeof f.store.meetings.relatedHistory>) => {
      const result = await f.store.meetings.relatedHistory(...args)
      f.db.prepare("UPDATE meetings SET updated_at=6000 WHERE id=?").run(saved.meeting.id)
      return result
    })
    const service = createMeetingPreparationService(f.key, f.accountId, {
      ...f.ports,
      meetings: { ...f.ports.meetings, relatedHistory },
    })
    const result = await service.prepare("example-series", f.request)
    expect(result.related.items).toEqual([])
    expect(result.coverage.skippedUnavailable).toEqual([`meeting:${f.accountId}/${saved.meeting.id}`])
    await expect(
      f.store.meetings.relatedHistory({ ...f.relatedRequest, signal: AbortSignal.abort() }),
    ).rejects.toThrow()
  })

  it("retains unqueried coverage without usable exact-series anchors", async () => {
    const f = await fixture()
    const result = await f.service.prepare("not-stored", f.request)
    expect(result.related).toMatchObject({ anchors: [], items: [] })
    expect(result.coverage.unqueried).toContain("person-history")
  })

  it("refuses invalid related selections and late cancellation from a custom port", async () => {
    const f = await fixture()
    await f.add("invented-related", { person: true })
    const page = await f.store.meetings.relatedHistory(f.relatedRequest)
    const entry = page.items[0]
    if (!entry) throw new Error("Missing invented related meeting")
    for (const bad of [
      { ...page, items: Array(6).fill(entry) },
      { ...page, items: [entry, entry] },
      { ...page, items: [{ ...entry, sharedPerson: false }] },
      { ...page, items: [{ ...entry, meeting: { ...entry.meeting, startedAt: 10000 } }] },
    ]) {
      const service = createMeetingPreparationService(f.key, f.accountId, {
        ...f.ports,
        meetings: { ...f.ports.meetings, relatedHistory: async () => bad },
      })
      await expect(service.prepare("example-series", f.request)).rejects.toMatchObject({ code: "invalid_response" })
    }
    const controller = new AbortController()
    const service = createMeetingPreparationService(f.key, f.accountId, {
      ...f.ports,
      meetings: {
        ...f.ports.meetings,
        relatedHistory: async () => {
          controller.abort()
          return page
        },
      },
    })
    await expect(service.prepare("example-series", { ...f.request, signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled",
    })
  })
})

describe("related history request validation", () => {
  it.each([
    { accountId: 0 },
    { seriesId: Infinity },
    { anchorIds: [0] },
    { anchorIds: Array(21).fill(1) },
    { after: 10000 },
    { before: NaN },
    { limit: 21 },
    { limit: 0 },
    { maxReadBytes: 0 },
    { maxReadBytes: 4194305 },
    { signal: {} },
    { unknown_field: true },
  ])("refuses %j", async (patch) => {
    const f = await fixture()
    expect(() =>
      validateMeetingRelatedHistory({ ...f.relatedRequest, ...patch } as MeetingRelatedHistoryRequest),
    ).toThrow()
  })
})
