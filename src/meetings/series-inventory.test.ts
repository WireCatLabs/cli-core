import { expect, it, vi } from "vitest"
import { createMeetingSeriesInventoryReader } from "./series-inventory.js"
import type {
  MeetingSeriesInventoryPage,
  MeetingSeriesInventoryRead,
  MeetingSeriesInventoryRequest,
} from "./series-inventory-types.js"
import { createUpcomingMeetingReader } from "./upcoming.js"

const after = Date.parse("2026-10-18T00:00:00Z"),
  until = after + 7 * 86400000
const item = (meetingId = "example-series") => ({
  meetingId,
  title: "Harbour Example planning",
  kind: "recurring" as const,
  scheduledStartAt: after - 86400000,
})
const fixture = (provider = "example-calendar", account = "AliceExample") => {
  const scope = { provider, account }
  const read = vi.fn(
    async (context: MeetingSeriesInventoryRead): Promise<MeetingSeriesInventoryPage> => ({
      scope: context.scope,
      after: context.after,
      until: context.until,
      items: [item()],
      nextCursor: context.cursor === undefined ? "next-example-page" : null,
      coverage: { selection: "provider-inventory", partial: false },
    }),
  )
  return { scope, read, service: createMeetingSeriesInventoryReader(scope, { read }) }
}

it.each(["example-calendar", "example-conference"])(
  "reads exactly one scoped page from %s and preserves unverified past recurrence hints",
  async (provider) => {
    const f = fixture(provider)
    const page = await f.service.page({ after, until })
    expect(f.read).toHaveBeenCalledExactlyOnceWith({ scope: f.scope, after, until, limit: 100, maxReadBytes: 65536 })
    expect(page).toMatchObject({
      scope: f.scope,
      items: [item()],
      coverage: {
        hasMore: true,
        undated: 0,
        dateHintsOutsideWindow: 1,
        occurrenceProof: "not-read",
        calendarCompleteness: "unknown",
      },
    })
    expect(page.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(page)).not.toContain("join_url")
    await f.service.page({ after, until, cursor: page.nextCursor ?? undefined })
    expect(f.read.mock.calls[1]?.[0].cursor).toBe("next-example-page")
    expect(f.read).toHaveBeenCalledTimes(2)
  },
)

it("retains empty pages with continuation, undated candidates and terminal source-partial coverage", async () => {
  const f = fixture()
  f.read.mockImplementationOnce(async (context) => ({
    after: context.after,
    until: context.until,
    scope: context.scope,
    items: [],
    nextCursor: "empty-page-continuation",
    coverage: { selection: "provider-window", partial: false },
  }))
  const empty = await f.service.page({ after, until })
  expect(empty).toMatchObject({ items: [], coverage: { hasMore: true } })
  f.read.mockImplementationOnce(async (context) => ({
    scope: context.scope,
    after,
    until,
    items: [{ ...item(), scheduledStartAt: null }],
    nextCursor: null,
    coverage: { selection: "provider-inventory", partial: true },
  }))
  const last = await f.service.page({ after, until, cursor: empty.nextCursor ?? undefined })
  expect(last).toMatchObject({
    nextCursor: null,
    coverage: { hasMore: false, undated: 1, sourcePartial: true, calendarCompleteness: "unknown" },
  })
})

it("captures scope, windows and limits before asynchronous provider work", async () => {
  const f = fixture()
  const request = { after, until, limit: 1, maxReadBytes: 8192, bytes: 8192 }
  f.read.mockImplementationOnce(async (context) => {
    f.scope.account = "ChangedExample"
    request.after = 0
    request.limit = 100
    request.bytes = 1048576
    expect(Object.isFrozen(context)).toBe(true)
    expect(Object.isFrozen(context.scope)).toBe(true)
    return {
      scope: context.scope,
      after: context.after,
      until: context.until,
      items: [item()],
      nextCursor: null,
      coverage: { selection: "provider-window", partial: false },
    }
  })
  const result = await f.service.page(request)
  expect(result).toMatchObject({ scope: { account: "AliceExample" }, after, limits: { limit: 1, bytes: 8192 } })
})

it("rejects cursors from another provider, account or window before a read", async () => {
  const f = fixture()
  const first = await f.service.page({ after, until })
  for (const foreign of [fixture("other-calendar"), fixture("example-calendar", "BobExample")]) {
    await expect(foreign.service.page({ after, until, cursor: first.nextCursor ?? undefined })).rejects.toMatchObject({
      code: "validation_error",
    })
    expect(foreign.read).not.toHaveBeenCalled()
  }
  await expect(
    f.service.page({ after: after + 1, until, cursor: first.nextCursor ?? undefined }),
  ).rejects.toMatchObject({ code: "validation_error" })
  expect(f.read).toHaveBeenCalledOnce()
})

it.each([
  { after: 0, until: 0 },
  { after, until: after - 1 },
  { after, until: after + 367 * 86400000 },
  { limit: 101 },
  { limit: 0 },
  { maxReadBytes: 0 },
  { bytes: 2047 },
  { bytes: 1048577 },
  { cursor: "!" },
  { cursor: Buffer.from("null").toString("base64url") },
  { provider: "foreign" },
  { signal: true },
])("rejects invalid request fields before the provider: %j", async (change) => {
  const f = fixture()
  await expect(f.service.page({ after, until, ...change } as MeetingSeriesInventoryRequest)).rejects.toMatchObject({
    code: "validation_error",
  })
  expect(f.read).not.toHaveBeenCalled()
})

it("rejects foreign selections, oversized/duplicate rows and accidental join links", async () => {
  for (const change of [
    { scope: { provider: "other-calendar", account: "AliceExample" } },
    { after: 0 },
    { items: [item(), item()] },
    { items: [{ ...item(), title: "x".repeat(8193) }] },
    { items: [{ ...item(), joinUrl: "https://example.invalid/join" }] },
    { items: [{ ...item(), scheduledStartAt: NaN }] },
    { nextCursor: "" },
    { nextCursor: "\u0001".repeat(1000) },
    { coverage: { selection: "provider-window", partial: "false" } },
  ]) {
    const f = fixture()
    const original = f.read.getMockImplementation()
    if (!original) throw Error("missing invented reader")
    f.read.mockImplementationOnce(
      async (context) => ({ ...(await original(context)), ...change }) as unknown as MeetingSeriesInventoryPage,
    )
    await expect(f.service.page({ after, until })).rejects.toMatchObject({ code: "invalid_response" })
    expect(f.read).toHaveBeenCalledOnce()
  }
})

it("refuses input/output byte budgets without hiding rows or advancing another page", async () => {
  const f = fixture()
  await expect(f.service.page({ after, until, maxReadBytes: 1 })).rejects.toMatchObject({ code: "invalid_response" })
  f.read.mockImplementationOnce(async (context) => ({
    scope: context.scope,
    after,
    until,
    items: [{ ...item(), title: "a".repeat(3000) }],
    nextCursor: "later-page",
    coverage: { selection: "provider-inventory", partial: false },
  }))
  await expect(f.service.page({ after, until, bytes: 2048 })).rejects.toMatchObject({ code: "validation_error" })
  expect(f.read).toHaveBeenCalledTimes(2)
})

it("preserves provider permission errors and cancellation before and during I/O", async () => {
  const f = fixture()
  const controller = new AbortController()
  controller.abort()
  await expect(f.service.page({ after, until, signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" })
  expect(f.read).not.toHaveBeenCalled()
  const error = new Error("invented permission refusal")
  f.read.mockRejectedValueOnce(error)
  await expect(f.service.page({ after, until })).rejects.toBe(error)
  const during = new AbortController()
  f.read.mockImplementationOnce(async (context) => {
    during.abort()
    return {
      scope: context.scope,
      after,
      until,
      items: [],
      nextCursor: null,
      coverage: { selection: "provider-window", partial: false },
    }
  })
  await expect(f.service.page({ after, until, signal: during.signal })).rejects.toMatchObject({ code: "cancelled" })
})

it("selects an exact series into the existing upcoming proof instead of trusting the listing date", async () => {
  const f = fixture()
  const page = await f.service.page({ after, until })
  const selected = page.items[0]
  if (!selected) throw Error("missing invented series")
  const read = vi.fn(async (meetingId: string) => ({
    meetingId,
    kind: "recurring" as const,
    timezone: "UTC",
    occurrences: [
      { id: "future-example", startAt: after + 3600000, endAt: null, status: "scheduled" as const, verified: true },
    ],
    complete: true,
    missing: [],
  }))
  const next = await createUpcomingMeetingReader(f.scope, { read }).next(selected.meetingId, { after, until })
  expect(next.verifiedNext).toBe(true)
  expect(next.candidate?.startAt).toBe(after + 3600000)
  expect(read).toHaveBeenCalledExactlyOnceWith(
    "example-series",
    expect.objectContaining({ scope: f.scope, after, until }),
  )
})
