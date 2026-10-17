import { describe, expect, it } from "vitest"
import { readinessGaps, readinessList } from "./conversation-answers.js"

describe("conversations status answer", () => {
  it("names group chats never built as missing, with the build step", () => {
    const body = readinessList({ model: "e5-small", chats: [], unbuiltGroups: 2 })
    expect(body.next).toMatchObject([{ step: "conversations.build", args: {} }])
    expect(body.missing).toEqual([
      { field: "items", why: "2 group chats were never built", step: "conversations.build" },
    ])
  })

  it("says nothing is missing when every group chat was built", () => {
    expect(readinessList({ model: "e5-small", chats: [] })).not.toHaveProperty("missing")
  })
})

const stale = {
  meaning: "searched" as const,
  model: "m",
  readiness: { searchedByMeaning: [], wordsOnly: [], partial: [], stale: [], notBuilt: [] },
  coverage: { state: "stale" as const },
}

describe("readinessGaps", () => {
  it("**UX-59: names the sync this messenger can run, and keeps the caveat where it can run none**", () => {
    const fetched = readinessGaps(stale, {})
    const pushed = readinessGaps(stale, { history: "store" }, "7")
    const onDemand = readinessGaps(stale, { history: "store", historyOnDemand: true }, "7")
    const onDemandAll = readinessGaps(stale, { history: "store", historyOnDemand: true })

    expect(fetched.next).toEqual([
      expect.objectContaining({ step: "messages.sync", args: { all: true, background: true } }),
    ])
    expect(onDemand.next).toEqual([expect.objectContaining({ step: "messages.sync", args: { chat: "7" } })])
    for (const gaps of [pushed, onDemandAll]) {
      expect(gaps.next).toEqual([])
      expect(gaps.missing).toEqual([{ field: "coverage", why: expect.stringContaining("stale") }])
    }
  })
})
