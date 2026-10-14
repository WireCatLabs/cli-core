import { describe, expect, it } from "vitest"
import { currentRun, inRun, useAsProcessRun } from "./scope.js"

describe("the process run", () => {
  it("is the run a one-shot command named, outside any inRun, and an inRun inside it still wins", () => {
    useAsProcessRun({ runId: "20261014T120000Z-bot-chats-list-abc123", command: "bot chats list" })

    expect(currentRun().runId).toBe("20261014T120000Z-bot-chats-list-abc123")
    expect(inRun({ runId: "tool-call", command: "chats list" }, () => currentRun().runId)).toBe("tool-call")
  })
})
