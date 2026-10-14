import { CliError } from "@wirecat/cli-base"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createUpcomingMeetingReader } from "../meetings/index.js"
import { preparationFixture } from "../testing/meeting-preparation.js"
import { createMeetingPreparationService } from "./meeting-preparation.js"
import type { MeetingPreparationPorts, MeetingPreparationRequest } from "./meeting-preparation-types.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})
const fixture = async (provider?: string) => {
  const f = await preparationFixture(provider)
  handles.push(f)
  const ports = { meetings: f.store.meetings, upcoming: f.upcoming }
  return { ...f, ports, service: createMeetingPreparationService(f.key, f.accountId, ports) }
}
const series = "example-series"

describe("shared meeting preparation", () => {
  it.each(["example-calendar", "sample-assistant"])(
    "composes cited stored context for %s without writes",
    async (provider) => {
      const f = await fixture(provider)
      const snapshot = () =>
        Object.fromEntries(
          ["meetings", "meeting_index_pending", "links", "facts", "tasks", "notes", "memories", "proposed_actions"].map(
            (table) => [table, f.db.prepare(`SELECT * FROM ${table}`).all()],
          ),
        )
      const before = snapshot()
      const result = await f.service.prepare(series, f.request)
      expect(result).toMatchObject({
        accountId: f.accountId,
        upcoming: { scope: f.key, verifiedNext: true, candidate: { id: "invented-next", startAt: 11000 } },
        series: { id: f.context.seriesId },
        coverage: {
          archiveCompleteness: "unknown",
          consistency: "live-reads",
          skippedUnavailable: [],
          outputLimited: false,
        },
      })
      expect(result.items).toHaveLength(1)
      expect(result.items[0]).toMatchObject({
        reference: f.reference,
        evidence: {
          items: [
            {
              text: "Ship the example plan.",
              reference: expect.stringMatching(/^meeting:\d+\/\d+\/\d+\/0$/),
              fingerprint: expect.any(String),
            },
          ],
        },
        context: {
          projects: { items: [{ ref: f.project.ref }] },
          facts: { items: [{ ref: f.fact.ref }] },
          tasks: { items: [{ ref: `task:${f.task.task.id}` }] },
        },
      })
      expect(f.reads()).toBe(1)
      expect(snapshot()).toEqual(before)
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(result.limits.bytes)
      result.items[0]?.context.facts.items.splice(0)
      expect((await f.service.prepare(series, f.request)).items[0]?.context.facts.items).toHaveLength(1)
    },
  )

  it("keeps unknown remote schedules and absent stored history useful without inventing completeness", async () => {
    const f = await fixture()
    const upcoming = createUpcomingMeetingReader(f.key, {
      read: async (meetingId) => ({
        meetingId,
        kind: "recurring",
        timezone: null,
        occurrences: [],
        complete: false,
        missing: ["occurrence-details"],
      }),
    })
    const service = createMeetingPreparationService(f.key, f.accountId, { ...f.ports, upcoming })
    const result = await service.prepare("not-stored", f.request)
    expect(result).toMatchObject({
      series: null,
      items: [],
      upcoming: { candidate: null, verifiedNext: false, coverage: { missing: ["occurrence-details"] } },
      coverage: { archiveCompleteness: "unknown" },
    })
  })

  it("preserves missing transcript coverage and deterministic bounded history", async () => {
    const f = await fixture()
    await f.store.meetings.saveMeeting({
      meeting: { ...f.input.meeting, externalId: "newer-invented", startedAt: 2000 },
      now: 4000,
    })
    await f.store.meetings.saveMeeting({
      meeting: { ...f.input.meeting, externalId: "undated-invented", startedAt: null },
      now: 4000,
    })
    const result = await f.service.prepare(series, { ...f.request, meetings: 1 })
    expect(result.items[0]?.meeting.externalId).toBe("newer-invented")
    expect(result.items[0]?.evidence.items).toEqual([])
    expect(result.coverage).toMatchObject({ historyHasMore: true, hasUndated: true })
  })

  it("skips a meeting whose stored series or revision changed after history selection", async () => {
    const f = await fixture()
    const meetings = {
      ...f.store.meetings,
      seriesHistory: async (...args: Parameters<typeof f.store.meetings.seriesHistory>) => {
        const result = await f.store.meetings.seriesHistory(...args)
        f.db.prepare("UPDATE meetings SET updated_at=6000 WHERE id=?").run(f.context.meetingId)
        return result
      },
    }
    const result = await createMeetingPreparationService(f.key, f.accountId, { ...f.ports, meetings }).prepare(
      series,
      f.request,
    )
    expect(result.items).toEqual([])
    expect(result.coverage.skippedUnavailable).toEqual([f.reference])
  })

  it("does not read another account or another stored series", async () => {
    const f = await fixture()
    await f.store.meetings.saveMeeting({
      ...f.input,
      meeting: { ...f.input.meeting, accountId: f.otherId, externalId: "foreign-occurrence" },
    })
    const original = f.input.meeting.series
    if (!original) throw new Error("Missing invented series")
    await f.store.meetings.saveMeeting({
      ...f.input,
      meeting: {
        ...f.input.meeting,
        externalId: "similar-title",
        series: { ...original, externalId: "unrelated-series" },
      },
    })
    expect((await f.service.prepare(series, f.request)).items.map((row) => row.reference)).toEqual([f.reference])
    const account = vi.fn(async () => ({ ...f.key, account: "BobSample" }))
    const service = createMeetingPreparationService(f.key, f.accountId, {
      ...f.ports,
      meetings: { ...f.ports.meetings, account },
    })
    await expect(service.prepare(series, f.request)).rejects.toMatchObject({ code: "not_found" })
    expect(f.reads()).toBe(1)
  })

  it("stops at a byte budget and marks omitted entries instead of emitting oversized output", async () => {
    const f = await fixture()
    f.db.prepare("UPDATE facts SET statement=? WHERE id=?").run("界".repeat(1000), Number(f.fact.id))
    const result = await f.service.prepare(series, { ...f.request, bytes: 4096 })
    expect(result.items).toEqual([])
    expect(result.coverage.outputLimited).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096)
  })

  it("refuses metadata larger than the output bound before reading transcripts", async () => {
    const f = await fixture()
    f.db.prepare("UPDATE meeting_series SET title=? WHERE id=?").run("界".repeat(2000), f.context.seriesId)
    const transcripts = vi.fn(f.store.meetings.transcripts.bind(f.store.meetings))
    const service = createMeetingPreparationService(f.key, f.accountId, {
      ...f.ports,
      meetings: { ...f.ports.meetings, transcripts },
    })
    await expect(service.prepare(series, { ...f.request, bytes: 4096 })).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(transcripts).not.toHaveBeenCalled()
  })

  it("captures scope and the selected upcoming method, refusing a mismatched reader", async () => {
    const f = await fixture()
    const scope = { ...f.key }
    const upcoming = { ...f.upcoming }
    const service = createMeetingPreparationService(scope, f.accountId, { ...f.ports, upcoming })
    scope.account = "BobSample"
    upcoming.next = async () => {
      throw new Error("Replacement must not run")
    }
    expect((await service.prepare(series, f.request)).upcoming.scope).toEqual(f.key)
    expect(() => createMeetingPreparationService(scope, f.accountId, f.ports)).toThrow("another provider or account")
  })

  it("refuses wrong upstream selection, oversized history and off-window rows", async () => {
    const f = await fixture()
    const result = await f.upcoming.next(series, { after: f.request.after, until: f.request.until })
    const wrong = { ...f.upcoming, next: async () => ({ ...result, meetingId: "other-series" }) }
    await expect(
      createMeetingPreparationService(f.key, f.accountId, { ...f.ports, upcoming: wrong }).prepare(series, f.request),
    ).rejects.toMatchObject({ code: "invalid_response" })
    const history = await f.store.meetings.seriesHistory({
      accountId: f.accountId,
      externalId: series,
      after: 0,
      before: 10000,
    })
    const storedSeries = history.series
    const entry = history.items[0]
    if (!storedSeries || !entry) throw new Error("Missing invented history")
    for (const bad of [
      { ...history, series: { ...storedSeries, externalId: "other" } },
      { ...history, items: Array.from({ length: 21 }, () => entry) },
      { ...history, series: null },
      { ...history, items: [{ ...entry, startedAt: 10000 }] },
    ]) {
      const meetings = { ...f.store.meetings, seriesHistory: async () => bad }
      await expect(
        createMeetingPreparationService(f.key, f.accountId, { ...f.ports, meetings }).prepare(series, f.request),
      ).rejects.toMatchObject({ code: "invalid_response" })
    }
  })

  it("propagates provider failures and store byte failures rather than presenting them as empty history", async () => {
    const f = await fixture()
    const upcoming = createUpcomingMeetingReader(f.key, {
      read: async () => {
        throw new CliError("not_found", "Invented schedule unavailable")
      },
    })
    await expect(
      createMeetingPreparationService(f.key, f.accountId, { ...f.ports, upcoming }).prepare(series, f.request),
    ).rejects.toMatchObject({ code: "not_found" })
    await expect(f.service.prepare(series, { ...f.request, maxReadBytes: 1 })).rejects.toMatchObject({
      code: "invalid_response",
    })
    f.db.prepare("UPDATE meetings SET metadata=? WHERE id=?").run("x".repeat(1000), f.context.meetingId)
    await expect(f.service.prepare(series, { ...f.request, maxReadBytes: 500 })).rejects.toMatchObject({
      code: "validation_error",
    })
  })

  it("preserves typed cancellation and refuses late cancelled evidence", async () => {
    const f = await fixture()
    const controller = new AbortController()
    const upcoming = createUpcomingMeetingReader(f.key, {
      read: async () => {
        controller.abort(new CliError("timeout", "Invented deadline"))
        throw new Error("Uncertain provider")
      },
    })
    await expect(
      createMeetingPreparationService(f.key, f.accountId, { ...f.ports, upcoming }).prepare(series, {
        ...f.request,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Uncertain provider")
    const after = new AbortController()
    const preparationContext = vi.fn(async (...args: Parameters<typeof f.store.meetings.preparationContext>) => {
      const result = await f.store.meetings.preparationContext(...args)
      after.abort(new CliError("timeout", "Invented late deadline"))
      return result
    })
    const service = createMeetingPreparationService(f.key, f.accountId, {
      ...f.ports,
      meetings: { ...f.ports.meetings, preparationContext },
    })
    await expect(service.prepare(series, { ...f.request, signal: after.signal })).rejects.toMatchObject({
      code: "timeout",
    })
  })
})

describe("preparation request validation", () => {
  it.each([
    { after: 0 },
    { until: 10000 },
    { historyAfter: NaN },
    { until: Infinity },
    { meetings: 0 },
    { meetings: 21 },
    { cues: 101 },
    { contextLimit: null },
    { bytes: 4095 },
    { bytes: 4194305 },
    { signal: {} },
    { unknown_field: true },
  ])("refuses %j before store/provider reads", async (patch) => {
    const f = await fixture()
    const account = vi.spyOn(f.store.meetings, "account")
    await expect(
      f.service.prepare(series, { ...f.request, ...patch } as MeetingPreparationRequest),
    ).rejects.toMatchObject({ code: "validation_error" })
    expect(account).not.toHaveBeenCalled()
    expect(f.reads()).toBe(0)
  })
  it("requires capabilities, account, request and series before work", async () => {
    const f = await fixture()
    expect(() => createMeetingPreparationService(f.key, 0, f.ports)).toThrow("accountId")
    expect(() => createMeetingPreparationService(f.key, f.accountId, {} as MeetingPreparationPorts)).toThrow(
      "requires bounded",
    )
    await expect(f.service.prepare("", f.request)).rejects.toMatchObject({ code: "validation_error" })
    await expect(f.service.prepare(series, null as unknown as MeetingPreparationRequest)).rejects.toMatchObject({
      code: "validation_error",
    })
    await expect(f.service.prepare(series, { ...f.request, signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: "cancelled",
    })
    await expect(
      f.service.prepare(series, {
        ...f.request,
        signal: AbortSignal.abort(new DOMException("Invented timeout", "TimeoutError")),
      }),
    ).rejects.toMatchObject({ code: "timeout" })
    expect(f.reads()).toBe(0)
  })
})
