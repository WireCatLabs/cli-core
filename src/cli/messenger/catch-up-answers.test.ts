import * as v from "valibot"
import { describe, expect, it } from "vitest"
import type { Message } from "../../domain/models.js"
import { ENTITIES } from "../../entities/index.js"
import { catchUpQuery, INBOX_QUERY, inboxAnswer, REVIEW_QUERY } from "./catch-up-answers.js"

describe("catchUpQuery", () => {
  it("takes comma-separated chat kinds in the native query", () => {
    for (const registry of [INBOX_QUERY, REVIEW_QUERY]) {
      expect(catchUpQuery(["kind:group,channel"], registry, "review").kinds).toEqual(["group", "channel"])
      expect(() => catchUpQuery(["kind:groups"], registry, "review")).toThrow(/kind:/)
    }
  })

  it("reads a start and a quoted chat, as review.next writes them", () => {
    expect(catchUpQuery('date>"2026-10-01T09:00:00.000Z" chat:"Book club"', REVIEW_QUERY, "review")).toEqual({
      since: Date.parse("2026-10-01T09:00:00.000Z"),
      chat: "Book club",
      meta: { timezone: expect.any(String), window: { since: "2026-10-01T09:00:00.000Z" } },
    })
  })

  it("reads a date alone in the computer's zone and reports that zone and the UTC window", () => {
    const processZone = process.env.TZ
    process.env.TZ = "Asia/Vladivostok"
    try {
      expect(catchUpQuery(["date>=2026-09-01"], INBOX_QUERY, "inbox").meta).toEqual({
        timezone: "Asia/Vladivostok",
        window: { since: "2026-08-31T14:00:00.000Z" },
      })
    } finally {
      process.env.TZ = processZone
    }
  })

  it("refuses an end: a catch-up reads from a point on", () => {
    expect(() => catchUpQuery(["date<2h"], INBOX_QUERY, "inbox")).toThrow(/from a point on/)
    expect(() => catchUpQuery(["chat:7"], INBOX_QUERY, "inbox")).toThrow()
  })
})

describe("inboxAnswer", () => {
  it("says which message the owner wrote", () => {
    const said = (id: string, outgoing: boolean): Message => ({
      id,
      chatId: "7",
      senderId: outgoing ? "500" : "9",
      senderName: outgoing ? "Me" : "Olga",
      timestamp: `2026-09-27T10:0${id}:00.000Z`,
      editedAt: null,
      text: `text ${id}`,
      outgoing,
      attachments: [],
      replyTo: null,
      forwardedFrom: null,
      reactions: null,
    })
    const answer = inboxAnswer(
      {
        mode: "unread",
        chats: [
          {
            id: "7",
            title: "Book club",
            kind: "group",
            unreadCount: 1,
            messages: [said("1", true), said("2", false)],
            more: false,
          },
        ],
        skipped: [],
        partial: false,
        quiet: 0,
      },
      undefined,
      { provider: "test", account: "500" },
      false,
    )

    for (const item of answer.items) v.parse(ENTITIES["message.summary"], item)
    expect(answer.items.map(({ sender_is_me }) => sender_is_me)).toEqual([true, false])
  })
})
