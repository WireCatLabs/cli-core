import { describe, expect, it } from "vitest"
import { readinessList } from "./conversation-answers.js"

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
