import { describe, expect, it } from "vitest"
import { type SentMail, senderSignalsOf } from "./sender-signals.js"

const one = (more: Partial<SentMail> = {}): SentMail => ({
  autoSubmitted: false,
  nullReturnPath: false,
  oneClick: false,
  feedbackId: false,
  bulk: false,
  discussionList: false,
  recipients: 1,
  ...more,
})
const alone = { addresses: [], ownerWrote: false, chatted: false }

describe("senderSignalsOf", () => {
  it("takes the reach most of their mail had, the wider on a tie", () => {
    expect(senderSignalsOf([one(), one(), one({ bulk: true })], alone).reach).toBe("direct")
    expect(senderSignalsOf([one(), one({ bulk: true })], alone)).toEqual({ signals: ["bulk-mail"], reach: "broadcast" })
  })

  it("is direct when the owner wrote to them or, with no mail, chats with them; else says nothing", () => {
    expect(senderSignalsOf([one({ feedbackId: true })], { ...alone, ownerWrote: true }).reach).toBe("direct")
    expect(senderSignalsOf([], { ...alone, chatted: true }).reach).toBe("direct")
    expect(senderSignalsOf([], alone).reach).toBeNull()
  })

  it("names a program only when most of their mail says so, and no recipients from an envelope", () => {
    expect(senderSignalsOf([one({ autoSubmitted: true }), one()], alone).signals).toEqual([])
    expect(senderSignalsOf([one({ recipients: null })], { ...alone, addresses: ["no-reply@x.example"] })).toEqual({
      signals: ["no-reply"],
      reach: "direct",
    })
  })
})
