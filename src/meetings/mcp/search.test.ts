import { expect, it, vi } from "vitest"
import { callMeetingHitSearchTool, meetingHitSearchTool } from "./search.js"

const page = {
  items: [],
  hasMore: false,
  nextCursor: null,
  coverage: {
    archiveCompleteness: "unknown" as const,
    currentRevisions: true as const,
    indexing: "ready" as const,
    indexCompleteness: "unknown" as const,
  },
}
it("offers the same bounded search without letting a tool caller choose an account", async () => {
  expect(meetingHitSearchTool.inputSchema.additionalProperties).toBe(false)
  expect(meetingHitSearchTool.inputSchema.properties).not.toHaveProperty("account_id")
  const search = vi.fn(async () => page)
  const result = await callMeetingHitSearchTool(search, {
    query: "budget",
    identity_id: 12,
    person_id: 34,
    project: "RES",
    topic: "costs",
    limit: 10,
  })
  expect(result.structuredContent).toEqual(page)
  expect(search).toHaveBeenCalledWith(
    "budget",
    expect.objectContaining({ participantIdentityId: 12, personId: 34, project: "RES", topic: "costs", limit: 10 }),
  )
  for (const input of [
    null,
    [],
    {},
    { query: "budget", account_id: 5 },
    { query: "budget", person_id: "34" },
    { query: "budget", topic: true },
    { query: "budget", limit: 1001 },
  ]) {
    search.mockClear()
    expect(await callMeetingHitSearchTool(search, input)).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "validation_error" } },
    })
    expect(search).not.toHaveBeenCalled()
  }
})
it("hides unexpected backend errors and preserves cancellation", async () => {
  expect(
    await callMeetingHitSearchTool(
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
  expect(await callMeetingHitSearchTool(search, { query: "budget" }, controller.signal)).toMatchObject({
    isError: true,
    structuredContent: { error: { code: "cancelled" } },
  })
  expect(search).not.toHaveBeenCalled()
})
