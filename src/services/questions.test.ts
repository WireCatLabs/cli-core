import { describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { questions } from "./questions.js"

const say = (id: string, from: "me" | "ana" | "bo", text: string, extra: Partial<Message> = {}): Message => ({
  id,
  chatId: "7",
  senderId: from === "me" ? "1" : from,
  senderName: from,
  timestamp: new Date(Date.UTC(2026, 0, 1, 10, Number(id))).toISOString(),
  editedAt: null,
  text,
  outgoing: from === "me",
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...extra,
})

const none = new Set<string>()

describe("questions with asker owner", () => {
  it("is unanswered when nobody spoke after the owner", () => {
    const found = questions([say("1", "ana", "hi"), say("2", "me", "when can you pay?")], {
      answerers: none,
      asker: "owner",
    })
    expect(found.map(({ question, answer }) => [question.id, answer?.id])).toEqual([["2", undefined]])
  })

  it("is answered by the next speaker", () => {
    const found = questions([say("1", "me", "is it ready?"), say("2", "ana", "yes")], {
      answerers: none,
      asker: "owner",
    })
    expect(found.map(({ answer }) => answer?.id)).toEqual(["2"])
  })

  it("is answered by a reply, even after someone else spoke", () => {
    const found = questions(
      [say("1", "me", "is it ready?"), say("2", "bo", "lunch?"), say("3", "ana", "yes", { replyToId: "1" })],
      { answerers: none, asker: "owner" },
    )
    expect(found.map(({ question, answer }) => [question.id, answer?.id])).toEqual([["1", "2"]])
  })

  it("is not answered by the owner's own next message, and others' questions are not listed", () => {
    const found = questions([say("1", "ana", "pay?"), say("2", "me", "ok, and the date?"), say("3", "me", "hello?")], {
      answerers: none,
      asker: "owner",
    })
    expect(found.map(({ question, answer }) => [question.id, answer?.id])).toEqual([
      ["2", undefined],
      ["3", undefined],
    ])
  })
})

describe("questions with the default asker", () => {
  it("still lists the questions of others", () => {
    const found = questions([say("1", "ana", "pay?"), say("2", "me", "yes")], { answerers: none })
    expect(found.map(({ question, answer }) => [question.id, answer?.id])).toEqual([["1", "2"]])
  })
})
