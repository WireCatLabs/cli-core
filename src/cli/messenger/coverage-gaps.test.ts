import { expect, it } from "vitest"
import type { ChatCoverage } from "../../services/chat-coverage.js"
import { coverageGaps } from "./search-answers.js"

const row = (chatId: string, state: ChatCoverage["completeness"]["state"], oldestAt: string | null): ChatCoverage => ({
  chatId,
  title: "Synthetic title",
  completeness: { chatId, state, upToDate: null, gaps: false, reachesStart: state === "complete", fetchedAt: null },
  held: { messages: oldestAt === null ? 0 : 262, oldestAt, newestAt: oldestAt },
})

it("names the first incomplete chat in a bounded step and a full one, from counts and dates only", () => {
  const { next, missing } = coverageGaps(
    [
      row("1", "complete", "2026-01-01T00:00:00Z"),
      row("2", "partial", "2026-09-12T08:00:00Z"),
      row("3", "unknown", null),
    ],
    0,
    "2026-08-30T00:00:00.000Z",
  )
  expect(next).toMatchObject([
    {
      step: "messages.sync",
      args: { chat: "2", since_time: "2026-08-30T00:00:00.000Z" },
      why: "held from 2026-09-12 only; this reads back to 2026-08-30",
    },
    { step: "messages.sync", args: { chat: "2" } },
  ])
  expect(missing).toEqual([
    {
      field: "history",
      why: "2 of 3 chats hold only part of their history; the first is held from 2026-09-12 only",
      step: "messages.sync",
    },
  ])
  expect(JSON.stringify([next, missing])).not.toContain("Synthetic")
})

it("gives the full sync alone without a window, says never fetched, and says nothing for whole chats", () => {
  expect(coverageGaps([row("3", "unknown", null)]).next).toMatchObject([{ args: { chat: "3" } }])
  expect(coverageGaps([row("3", "unknown", null)]).missing[0]?.why).toContain("the first is never fetched")
  expect(coverageGaps([row("1", "complete", "2026-01-01T00:00:00Z")], 0, "2026-08-30T00:00:00.000Z")).toEqual({
    next: [],
    missing: [],
  })
})

it("says a chat that reaches its first message is behind or has gaps, not held from a date only", () => {
  const reaching = (gaps: boolean): ChatCoverage => ({
    ...row("4", "partial", "2026-04-30T00:00:00Z"),
    completeness: { chatId: "4", state: "partial", upToDate: false, gaps, reachesStart: true, fetchedAt: null },
    held: { messages: 262, oldestAt: "2026-04-30T00:00:00Z", newestAt: "2026-10-20T00:00:00Z" },
  })
  expect(coverageGaps([reaching(false)]).missing[0]?.why).toContain(
    "the first is held from its first message, behind since 2026-10-20",
  )
  expect(coverageGaps([reaching(true)]).missing[0]?.why).toContain(
    "the first is held from its first message, with gaps",
  )
})
