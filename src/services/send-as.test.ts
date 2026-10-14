import { describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { Chat, SenderIdentity } from "../domain/models.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import type { GuardRequest, SendGuard } from "../sends/guard.js"
import type { SendEntry } from "../sends/journal.js"
import { guardedCreatePoll } from "../sends/polls.js"
import { chatsService } from "./chats.js"
import { onlineDeps } from "./deps.js"
import { messagesService } from "./messages.js"

const messenger = { provider: "test", chatArgument: "a chat" } as Messenger
const chat: Chat = {
  id: "-1007",
  title: "Synthetic group",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
}
const identities: SenderIdentity[] = [
  { id: "500", title: "Owner", kind: "self", premiumRequired: false, default: false },
  { id: "-1002", title: "Synthetic channel", kind: "channel", premiumRequired: false, default: true },
]

const setup = (options: { capable?: boolean; saved?: string | null } = {}) => {
  const journal: Omit<SendEntry, "at" | "profile">[] = []
  const checked: GuardRequest[] = []
  const guard = {
    check: (request: GuardRequest) => checked.push(request),
    record: (entry: Omit<SendEntry, "at" | "profile">) => journal.push(entry),
  } as unknown as SendGuard
  const sendAsIdentities = vi.fn(async () => identities)
  const resolve = vi.fn(async () => chat)
  const send = vi.fn(async (chatId: string, text: string, sent: { sendId: string }) => ({
    sendId: sent.sendId,
    message: { id: "4", chatId, text } as never,
  }))
  const forward = vi.fn(async (_from: string, _message: string, toChatId: string) => ({ id: "9", chatId: toChatId }))
  const createPoll = vi.fn(async (chatId: string, _poll: unknown, options: { sendId: string }) => ({
    sendId: options.sendId,
    message: { id: "5", chatId } as never,
  }))
  const adapter = {
    self: () => "500",
    resolve,
    send,
    forward,
    createPoll,
    validateThread: async () => {},
    ...(options.capable === false ? {} : { sendAsIdentities, savedSender: async () => options.saved ?? null }),
  } as unknown as MessengerAdapter
  const deps = onlineDeps(messenger, adapter, guard)
  return { deps, adapter, guard, journal, checked, sendAsIdentities, resolve, send, forward, createPoll }
}

describe("listing sender identities", () => {
  it("asks the adapter with the resolved chat id", async () => {
    const { deps, sendAsIdentities } = setup()
    expect(await chatsService(deps).sendAs("Synthetic group")).toEqual(identities)
    expect(sendAsIdentities).toHaveBeenCalledWith("-1007")
  })

  it("refuses offline and a messenger without the capability", async () => {
    const offline = setup()
    const connection = vi.fn(offline.deps.connection)
    await expect(chatsService({ ...offline.deps, offline: true, connection }).sendAs("x")).rejects.toThrow(
      "not with --offline",
    )
    expect(connection).not.toHaveBeenCalled()
    const lacking = setup({ capable: false })
    await expect(chatsService(lacking.deps).sendAs("x")).rejects.toThrow("cannot send as another identity")
    expect(lacking.resolve).not.toHaveBeenCalled()
  })
})

describe("sending as an identity", () => {
  it("passes the identity to the adapter and the journal", async () => {
    const { deps, send, journal, checked } = setup()
    await messagesService(deps).send({ chat: "Synthetic group", text: "hello", sendAs: "-1002", threadId: "3" })
    expect(send).toHaveBeenCalledWith("-1007", "hello", expect.objectContaining({ sendAs: "-1002" }))
    expect(checked[0]).toMatchObject({ sendAs: "-1002" })
    expect(journal).toEqual([expect.objectContaining({ outcome: "sent", sendAs: "-1002" })])
  })

  it("refuses an id the chat does not offer, before the guard", async () => {
    const { deps, send, checked } = setup()
    await expect(messagesService(deps).send({ chat: "x", text: "hello", sendAs: "-1099" })).rejects.toThrow(
      "not an identity this account may post as",
    )
    expect(checked).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })

  it("refuses rather than falling back when the messenger cannot send as another identity", async () => {
    const { deps, send, resolve } = setup({ capable: false })
    await expect(messagesService(deps).send({ chat: "x", text: "hello", sendAs: "-1002" })).rejects.toThrow(
      "cannot send as another identity",
    )
    expect(resolve).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it("sends an attachment as the identity", async () => {
    const { deps, send } = setup()
    await messagesService(deps).send({
      chat: "x",
      text: "caption",
      sendAs: "-1002",
      attachments: [
        { kind: "file", name: "synthetic.txt", source: { kind: "bytes" as const, bytes: new Uint8Array([1]) } },
      ],
    })
    expect(send).toHaveBeenCalledWith("-1007", "caption", expect.objectContaining({ sendAs: "-1002" }))
  })

  it("leaves a send without an identity untouched", async () => {
    const { deps, send, sendAsIdentities, journal } = setup()
    await messagesService(deps).send({ chat: "x", text: "hello" })
    expect(sendAsIdentities).not.toHaveBeenCalled()
    expect(send.mock.calls[0]?.[2]).not.toHaveProperty("sendAs")
    expect(journal[0]).not.toHaveProperty("sendAs")
  })
})

describe("forwarding and polls as an identity", () => {
  const poll = { question: "Friday?", answers: ["yes", "no"], multiple: false, anonymous: false }

  it("checks the identity in the chat a forward lands in and passes it on", async () => {
    const { deps, forward, sendAsIdentities, journal } = setup()
    await messagesService(deps).forward({ chat: "from", message: "3", to: "to", silent: false, sendAs: "-1002" })
    expect(sendAsIdentities).toHaveBeenCalledOnce()
    expect(forward).toHaveBeenCalledWith("-1007", "3", "-1007", expect.objectContaining({ sendAs: "-1002" }))
    expect(journal[0]).toMatchObject({ kind: "forward", sendAs: "-1002" })
  })

  it("creates a poll as the identity, and refuses one the chat does not offer", async () => {
    const { adapter, guard, createPoll, journal } = setup()
    await guardedCreatePoll(guard, adapter, { chat: "x", poll, silent: false, sendAs: "-1002" })
    expect(createPoll).toHaveBeenCalledWith("-1007", poll, expect.objectContaining({ sendAs: "-1002" }))
    expect(journal[0]).toMatchObject({ sendAs: "-1002" })
    await expect(
      guardedCreatePoll(guard, adapter, { chat: "x", poll, silent: false, sendAs: "-1099" }),
    ).rejects.toThrow("not an identity")
    expect(createPoll).toHaveBeenCalledOnce()
  })

  it("refuses a forward or a poll as an identity on a messenger without them", async () => {
    const { deps, adapter, guard, forward, createPoll } = setup({ capable: false })
    await expect(
      messagesService(deps).forward({ chat: "from", message: "3", to: "to", silent: false, sendAs: "-1002" }),
    ).rejects.toThrow("cannot send as another identity")
    await expect(
      guardedCreatePoll(guard, adapter, { chat: "x", poll, silent: false, sendAs: "-1002" }),
    ).rejects.toThrow("cannot send as another identity")
    expect(forward).not.toHaveBeenCalled()
    expect(createPoll).not.toHaveBeenCalled()
  })
})

describe("a chat that posts as someone else by default", () => {
  const poll = { question: "Friday?", answers: ["yes", "no"], multiple: false, anonymous: false }

  it("refuses a send, a forward and a poll with no identity named, before the guard, naming both ids", async () => {
    const { deps, adapter, guard, send, forward, createPoll, checked } = setup({ saved: "-1002" })
    const service = messagesService(deps)
    const refused = { code: "validation_error", message: expect.stringContaining("--send-as 500 to post as yourself") }
    await expect(service.send({ chat: "x", text: "hello" })).rejects.toMatchObject(refused)
    await expect(service.forward({ chat: "from", message: "3", to: "to", silent: false })).rejects.toMatchObject(
      refused,
    )
    await expect(guardedCreatePoll(guard, adapter, { chat: "x", poll, silent: false })).rejects.toMatchObject(refused)
    await expect(service.send({ chat: "x", text: "hello" })).rejects.toThrow("--send-as -1002 to post as it")
    expect([send, forward, createPoll].map((one) => one.mock.calls.length)).toEqual([0, 0, 0])
    expect(checked).toEqual([])
  })

  it("lets a send through that names an identity, the account's own included", async () => {
    const { deps, send } = setup({ saved: "-1002" })
    await messagesService(deps).send({ chat: "x", text: "hello", sendAs: "500" })
    await messagesService(deps).send({ chat: "x", text: "hello", sendAs: "-1002" })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it("changes nothing where the saved sender is the account, or the messenger cannot say", async () => {
    for (const options of [{ saved: null }, { capable: false }]) {
      const { deps, send } = setup(options)
      await messagesService(deps).send({ chat: "x", text: "hello" })
      expect(send).toHaveBeenCalledOnce()
    }
  })
})
