import { CliError } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
import { createUpcomingMeetingReader } from "./upcoming.js"
import type { MeetingOccurrence, MeetingOccurrenceSchedule, UpcomingMeetingRequest } from "./upcoming-types.js"

const after = Date.parse("2026-10-25T00:00:00Z")
const until = Date.parse("2026-10-26T00:00:00Z")
const occurrence = (id = "example-occurrence", startAt: number | null = after): MeetingOccurrence => ({
  id,
  startAt,
  endAt: startAt === null ? null : startAt + 1_800_000,
  status: "scheduled",
  verified: startAt !== null,
})
const schedule = (change: Partial<MeetingOccurrenceSchedule> = {}): MeetingOccurrenceSchedule => ({
  meetingId: "example-series",
  kind: "recurring",
  timezone: "Europe/Madrid",
  occurrences: [occurrence()],
  complete: true,
  missing: [],
  ...change,
})
const reader = (value = schedule()) => {
  const read = vi.fn(async () => value)
  return { read, sdk: createUpcomingMeetingReader({ provider: "calendar-example", account: "example" }, { read }) }
}

describe.each(["zoom-example", "calendar-example"])("%s normalized provider contract", (provider) => {
  it("selects actual recurring occurrences across the DST boundary, not the series date", async () => {
    const read = vi.fn(async () => schedule({ occurrences: [occurrence("second", after + 5_400_000), occurrence()] }))
    const sdk = createUpcomingMeetingReader({ provider, account: "example" }, { read })
    const answer = await sdk.next("example-series", { after, until })
    expect(answer).toMatchObject({ candidate: { id: "example-occurrence", startAt: after }, verifiedNext: true })
    expect(read.mock.calls).toHaveLength(1)
    expect(read).toHaveBeenCalledWith("example-series", {
      scope: { provider, account: "example" },
      after,
      until,
      limit: 100,
      maxReadBytes: 1_048_576,
    })
  })
})

it("supports a verified nonrecurring meeting without inventing an occurrence id", async () => {
  const { sdk } = reader(schedule({ kind: "single", occurrences: [{ ...occurrence(), id: null }] }))
  expect(await sdk.next("example-series", { after, until })).toMatchObject({
    verifiedNext: true,
    candidate: { id: null },
  })
})

it("uses a half-open window and excludes cancelled occurrences", async () => {
  const { sdk } = reader(
    schedule({
      occurrences: [
        occurrence("past", after - 1),
        occurrence("edge", until),
        { ...occurrence("cancelled"), status: "cancelled" },
        occurrence("next", after + 1),
      ],
    }),
  )
  expect(await sdk.next("example-series", { after, until })).toMatchObject({
    candidate: { id: "next" },
    verifiedNext: true,
    coverage: { inspected: 4, cancelled: 1 },
  })
})

it.each([
  schedule({ complete: false }),
  schedule({ occurrences: [occurrence(), occurrence("undated", null)] }),
  schedule({ occurrences: [occurrence(), occurrence("tie")] }),
  schedule({ occurrences: [{ ...occurrence(), verified: false }] }),
  schedule({ occurrences: [occurrence(), { ...occurrence("uncertain-past", after - 1), verified: false }] }),
  schedule({ occurrences: [occurrence(), { ...occurrence("uncertain-future", until + 1), verified: false }] }),
  schedule({ kind: "unknown", occurrences: [{ ...occurrence(), verified: false }] }),
])(
  "retains candidates without claiming a verified next occurrence for incomplete or ambiguous schedules",
  async (value) => {
    const { sdk } = reader(value)
    expect(await sdk.next("example-series", { after, until })).toMatchObject({ verifiedNext: false })
  },
)

it("returns missing detail capability without login, writes or a fabricated date", async () => {
  const { sdk } = reader(
    schedule({ kind: "unknown", occurrences: [], complete: false, missing: ["occurrence-details"] }),
  )
  expect(await sdk.next("example-series", { after, until })).toMatchObject({
    candidate: null,
    verifiedNext: false,
    coverage: { scheduleComplete: false, missing: ["occurrence-details"] },
  })
  expect(
    await reader(schedule({ kind: "unscheduled", occurrences: [] })).sdk.next("example-series", { after, until }),
  ).toMatchObject({ candidate: null, verifiedNext: false })
})

it.each([
  { after: NaN, until },
  { after: 0.5, until },
  { after, until: after },
  { after, until, limit: 0 },
  { after, until, limit: 1001 },
  { after, until, maxReadBytes: 0 },
  { after, until, maxReadBytes: 4_194_305 },
  { after, until, unknown_field: true },
])("validates bounded selection before provider I/O", async (request) => {
  const { sdk, read } = reader()
  await expect(sdk.next("example-series", request)).rejects.toMatchObject({ code: "validation_error" })
  expect(read).not.toHaveBeenCalled()
})

it("rejects missing/invalid ids and requests before I/O", async () => {
  const { sdk, read } = reader()
  await expect(sdk.next("", { after, until })).rejects.toMatchObject({ code: "validation_error" })
  await expect(sdk.next("example-series", null as unknown as UpcomingMeetingRequest)).rejects.toMatchObject({
    code: "validation_error",
  })
  expect(read).not.toHaveBeenCalled()
  expect(() => createUpcomingMeetingReader({ provider: "x", account: "x" }, {} as never)).toThrow(/reader/)
})

it.each([
  { meetingId: "foreign-series" },
  { kind: "unknown" },
  { timezone: "not/an/iana-zone" },
  { complete: true, missing: ["schedule-details"] },
  { occurrences: [occurrence(), occurrence()] },
  { occurrences: [{ ...occurrence(), id: null }] },
  { occurrences: [{ ...occurrence(), endAt: after - 1 }] },
  { occurrences: [{ ...occurrence(), startAt: null }] },
  { occurrences: [{ ...occurrence(), private_value: "invented" }] },
])("refuses invalid or conflicting provider proof", async (change) => {
  const value = { ...schedule(), ...change } as MeetingOccurrenceSchedule
  await expect(reader(value).sdk.next("example-series", { after, until })).rejects.toMatchObject({
    code: "invalid_response",
  })
})

it("enforces byte/row budgets and gives the adapter the caller's bounds", async () => {
  const { sdk, read } = reader(schedule({ occurrences: [occurrence("first"), occurrence("second", after + 1)] }))
  await expect(sdk.next("example-series", { after, until, limit: 1 })).rejects.toMatchObject({
    code: "invalid_response",
  })
  expect(read).toHaveBeenCalledWith("example-series", expect.objectContaining({ limit: 1 }))
  await expect(sdk.next("example-series", { after, until, maxReadBytes: 1 })).rejects.toMatchObject({
    code: "invalid_response",
  })
})

it("captures the selected scope and port and detaches returned proof", async () => {
  const original = occurrence()
  const value = schedule({ occurrences: [original] })
  const scope = { provider: "calendar-example", account: "example" }
  const port = { read: vi.fn(async () => value) }
  const sdk = createUpcomingMeetingReader(scope, port)
  port.read = vi.fn(async () => {
    throw new Error("replacement must not run")
  })
  scope.account = "foreign"
  const answer = await sdk.next("example-series", { after, until })
  original.startAt = until
  expect(answer.scope.account).toBe("example")
  expect(answer.candidate?.startAt).toBe(after)
  expect(Object.isFrozen(answer.scope)).toBe(true)
})

it.each([
  null,
  [],
  { ...schedule(), kind: "foreign" },
  { ...schedule(), timezone: 42 },
  { ...schedule(), complete: null },
  { ...schedule(), missing: ["foreign"] },
  { ...schedule(), missing: ["schedule-details", "schedule-details"] },
  { ...schedule(), private_value: "invented" },
  { ...schedule(), occurrences: [null] },
  { ...schedule(), occurrences: [{ ...occurrence(), id: "\n" }] },
  { ...schedule(), occurrences: [{ ...occurrence(), startAt: Infinity }] },
  { ...schedule(), occurrences: [{ ...occurrence(), status: "foreign" }] },
  { ...schedule(), kind: "single", occurrences: [occurrence(), occurrence("second")] },
])("validates untrusted normalized schedule fields", async (input) => {
  const { sdk } = reader(input as MeetingOccurrenceSchedule)
  await expect(sdk.next("example-series", { after, until })).rejects.toMatchObject({ code: "invalid_response" })
})

it("retains an empty complete window without inventing a date or timezone", async () => {
  const { sdk } = reader(schedule({ occurrences: [], timezone: null }))
  expect(await sdk.next("example-series", { after, until })).toMatchObject({
    candidate: null,
    timezone: null,
    verifiedNext: false,
    coverage: { scheduleComplete: true, inspected: 0 },
  })
})

it("names an invalid signal before I/O and never retries provider failures", async () => {
  const { sdk, read } = reader()
  await expect(sdk.next("example-series", { after, until, signal: {} as AbortSignal })).rejects.toMatchObject({
    code: "validation_error",
  })
  expect(read).not.toHaveBeenCalled()
  const failure = new Error("example transport failure")
  const fail = vi.fn(async () => {
    throw failure
  })
  const service = createUpcomingMeetingReader({ provider: "x", account: "x" }, { read: fail })
  await expect(service.next("example-series", { after, until })).rejects.toBe(failure)
  expect(fail).toHaveBeenCalledTimes(1)
})

it("stops cancelled reads before I/O and rejects a late result", async () => {
  for (const reason of [
    undefined,
    new DOMException("deadline", "TimeoutError"),
    new CliError("cancelled", "example"),
  ]) {
    const controller = new AbortController()
    controller.abort(reason)
    const { sdk, read } = reader()
    await expect(sdk.next("example-series", { after, until, signal: controller.signal })).rejects.toMatchObject({
      code: reason instanceof DOMException ? "timeout" : "cancelled",
    })
    expect(read).not.toHaveBeenCalled()
  }
  const controller = new AbortController()
  const sdk = createUpcomingMeetingReader(
    { provider: "x", account: "x" },
    {
      read: async () => {
        controller.abort()
        return schedule()
      },
    },
  )
  await expect(sdk.next("example-series", { after, until, signal: controller.signal })).rejects.toMatchObject({
    code: "cancelled",
  })
})
