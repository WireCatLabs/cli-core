import { describe, expect, it } from "vitest"
import { catchUpQuery, INBOX_QUERY, REVIEW_QUERY } from "./catch-up-answers.js"

describe("catchUpQuery", () => {
  it("reads a start and a quoted chat, as review.next writes them", () => {
    expect(catchUpQuery('date>"2026-10-01T09:00:00.000Z" chat:"Book club"', REVIEW_QUERY, "review")).toEqual({
      since: Date.parse("2026-10-01T09:00:00.000Z"),
      chat: "Book club",
    })
  })

  it("refuses an end: a catch-up reads from a point on", () => {
    expect(() => catchUpQuery(["date<2h"], INBOX_QUERY, "inbox")).toThrow(/from a point on/)
    expect(() => catchUpQuery(["chat:7"], INBOX_QUERY, "inbox")).toThrow()
  })
})
