import { expect, it, vi } from "vitest"
import { callMeetingSearchTool, meetingSearchTool } from "./search.js"

const page = {
  items: [{ ref: "meeting:1/2", meetingId: 2, scope: "chat" as const, id: 4, text: "budget", startMs: null }],
  hasMore: false,
  nextCursor: null,
  coverage: {
    archiveCompleteness: "unknown" as const,
    currentRevisions: true as const,
    indexing: "pending" as const,
    indexCompleteness: "unknown" as const,
  },
}
it("offers the same bounded search without letting a tool caller choose an account", async () => {
  expect(meetingSearchTool.inputSchema.additionalProperties).toBe(false)
  expect(meetingSearchTool.inputSchema.properties).not.toHaveProperty("account_id")
  const search = vi.fn(async () => page)
  const result = await callMeetingSearchTool(search, {
    query: "budget",
    identity_id: 12,
    person_id: 34,
    event_id: 56,
    series_id: 78,
    project: "RES",
    topic: "costs",
    limit: 10,
  })
  expect(result.structuredContent).toEqual({
    items: [{ ref: "meeting:1/2", meeting: "meeting:1/2", scope: "chat", id: "4", excerpt: "budget", offset_ms: null }],
    page: { limit: 10, has_more: false },
    next: [expect.objectContaining({ step: "meetings.search-again", command: "search meetings" })],
    missing: [expect.objectContaining({ field: "excerpt", step: "meetings.search-again" })],
  })
  expect(search).toHaveBeenCalledWith(
    "budget",
    expect.objectContaining({
      participantIdentityId: 12,
      personId: 34,
      eventId: 56,
      meetingSeriesId: 78,
      project: "RES",
      topic: "costs",
      limit: 10,
    }),
  )
  for (const input of [
    null,
    [],
    {},
    { query: "budget", account_id: 5 },
    { query: "budget", person_id: "34" },
    { query: "budget", event_id: 0 },
    { query: "budget", after: "abc" },
    { query: "budget", topic: true },
    { query: "budget", limit: 1001 },
  ]) {
    search.mockClear()
    expect(await callMeetingSearchTool(search, input)).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "validation_error" } },
    })
    expect(search).not.toHaveBeenCalled()
  }
})
it("hides unexpected backend errors and preserves cancellation", async () => {
  expect(
    await callMeetingSearchTool(
      async () => {
        throw new Error("private backend details")
      },
      { query: "budget" },
    ),
  ).toMatchObject({
    isError: true,
    structuredContent: {
      error: { code: "internal_error", reason: "command.crashed", message: "the command failed; this is a bug" },
    },
  })
  const controller = new AbortController()
  controller.abort()
  const search = vi.fn(async () => page)
  expect(await callMeetingSearchTool(search, { query: "budget" }, controller.signal)).toMatchObject({
    isError: true,
    structuredContent: { error: { code: "cancelled" } },
  })
  expect(search).not.toHaveBeenCalled()
})
