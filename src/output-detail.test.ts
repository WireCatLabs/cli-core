import { describe, expect, it } from "vitest"
import { atDetail } from "./output-detail.js"
import { excerpt } from "./services/excerpt.js"

const hit = {
  locator: "msg:telegram/1/7/1",
  chatTitle: "Book club",
  timestamp: "2026-01-01T10:00:00.000Z",
  senderName: "Alice Example",
  text: "Which chapter next?",
  editedAt: null,
  replyTo: null,
  reactions: null,
  providerMetadata: { topic: 3 },
}

describe("atDetail", () => {
  it("keeps a message's text when it has no excerpt, and drops only the empty messenger fields", () => {
    expect(atDetail({ items: [hit], hasMore: false })).toEqual({
      items: [
        {
          locator: hit.locator,
          chatTitle: "Book club",
          timestamp: hit.timestamp,
          senderName: "Alice Example",
          text: "Which chapter next?",
          providerMetadata: { topic: 3 },
        },
      ],
      hasMore: false,
    })
  })

  it("cuts a messenger search hit, written in snake_case with a ref, to its brief fields", () => {
    const found = {
      ref: "msg:telegram/1/7/1",
      chat_title: "Book club",
      timestamp: "2026-01-01T10:00:00.000Z",
      sender_name: "Alice Example",
      sender_is_me: false,
      excerpt: "Which chapter next?",
      matched_in: "text",
      score: 2.5,
      found_in: "archive",
    }
    expect(atDetail({ items: [found] }, "brief")).toEqual({
      items: [
        {
          ref: found.ref,
          chat_title: "Book club",
          timestamp: found.timestamp,
          sender_name: "Alice Example",
          excerpt: "Which chapter next?",
          score: 2.5,
        },
      ],
    })
    expect(atDetail({ items: [found] })).toEqual({ items: [found] })
  })

  it("leaves a result with no found messages, and full, unchanged", () => {
    const chats = { items: [{ id: "7", title: "Book club" }] }
    expect(atDetail(chats, "brief")).toEqual(chats)
    expect(atDetail([hit], "full")).toEqual([hit])
  })
})

describe("excerpt", () => {
  it("shows the stretch around the first query word, marked where it was cut", () => {
    const text = `${"filler words here. ".repeat(30)}The budget was approved on Friday. ${"more. ".repeat(40)}`
    const shown = excerpt(text, "subject:offsite budget", 80)
    expect(shown).toContain("budget was approved")
    expect(shown.startsWith("…") && shown.endsWith("…")).toBe(true)
    expect(shown.length).toBeLessThanOrEqual(82)
  })

  it("is the whole text when it is short, on one line", () => {
    expect(excerpt("Line one\n\nline two", "nothing")).toBe("Line one line two")
  })
})
