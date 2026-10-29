import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { ENTITIES } from "../../entities/index.js"
import { messageItem, type ReadMessage } from "./message-items.js"

const reader = { provider: "telegram", account: "500" }
const at = "2026-10-13T10:00:00.000Z"
const quoted = {
  id: "1",
  senderId: "9",
  senderName: "Synthetic",
  timestamp: null,
  text: "q",
  attachments: [],
  outgoing: false,
}
const full: ReadMessage = {
  id: "3",
  chatId: "7",
  senderId: "9",
  senderName: "Synthetic sender",
  senderUsername: "synthetic",
  senderIsChat: false,
  mentions: ["10"],
  timestamp: at,
  editedAt: at,
  text: "",
  transcript: "synthetic words",
  anchor: true,
  outgoing: true,
  attachments: [
    { kind: "voice", mime: "audio/ogg", duration: 3, providerRef: { file: "opaque" } },
    {
      kind: "photo",
      width: 10,
      height: 10,
      buttons: [
        [
          { kind: "callback", text: "yes" },
          { kind: "link", text: "open", url: "https://example.test" },
        ],
      ],
    },
  ],
  replyTo: quoted,
  replyToId: "1",
  forwardedFrom: { ...quoted, outgoing: null },
  threadId: "12",
  threadRootId: "11",
  reactions: { counts: [{ reaction: "👍", count: 2 }], mine: "👍", total: 2 },
  counterObservations: { views: { value: 4, observedAt: at, source: "remote_fetch" } },
  scheduledFor: at,
  providerMetadata: { views: 4 },
}

describe("a message as commands answer it", () => {
  it("fits the message entity, with every field a read can carry", () => {
    const item = messageItem(full, reader)
    const parsed = v.safeParse(ENTITIES.message, item)
    expect(parsed.issues?.map((issue) => `${v.getDotPath(issue)}: ${issue.message}`)).toBeUndefined()
    expect(item).toMatchObject({ ref: "msg:telegram/500/7/3", provider: "telegram", account: "500", anchor: true })
    expect(JSON.stringify(item)).not.toContain("opaque")
  })

  it("says whether the account sent it, also when the messenger leaves the owner's sender id out", () => {
    const sentBy = (patch: Partial<ReadMessage>) => messageItem({ ...full, ...patch }, reader).sender_is_me
    expect(sentBy({ senderId: "9", outgoing: false })).toBe(false)
    expect(sentBy({ senderId: "500", outgoing: null })).toBe(true)
    expect(sentBy({ senderId: null, outgoing: true })).toBe(true)
    expect(sentBy({ senderId: null, outgoing: null })).toBe(false)
  })

  it("keeps an email's own locator and account, not the reader's", () => {
    const locator = "msg:email/owner%40example.test/thread-9/%3Ca%40example.test%3E"
    const person = { name: null, address: "a@example.test", ref: null }
    const email: ReadMessage = {
      ...full,
      locator,
      chatTitle: "Synthetic subject",
      excerpt: "words",
      email: {
        subject: "s",
        from: person,
        to: [person],
        cc: [],
        bcc: [],
        replyTo: [person],
        labels: ["INBOX"],
        thread: "chat:email/owner%40example.test/thread-9",
        read: true,
        flagged: null,
      },
    }
    const item = messageItem(email, reader)
    expect(v.safeParse(ENTITIES.message, item).success).toBe(true)
    expect(item).toMatchObject({ ref: locator, provider: "email", account: "owner@example.test" })
    expect(item.email?.reply_addresses).toEqual([person])
  })
})
