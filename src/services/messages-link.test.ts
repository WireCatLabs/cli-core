import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import { observed } from "../cli/messenger/observed.js"
import type { MessagePermalink } from "../domain/message-link.js"
import type { Message } from "../domain/models.js"
import { type MessengerAdapter, throughWrapper } from "../ports/messenger.js"
import type { SendGuard } from "../sends/guard.js"
import { type MessageStore, openStore } from "../store/store.js"
import { type ServiceDeps, storedDeps } from "./deps.js"
import { messagesService } from "./messages.js"

const account = { provider: "test", account: "500" }
const messenger = { provider: "test", chatArgument: "a chat", app: { command: "test" } } as Messenger
const chat = {
  id: "7",
  title: "Synthetic",
  kind: "group" as const,
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
}
const message: Message = {
  id: "9007199254740993123",
  chatId: "7",
  senderId: "9",
  senderName: "Synthetic",
  text: "synthetic private body",
  timestamp: "2026-10-03T00:00:00.000Z",
  editedAt: null,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}
const guard = {} as SendGuard
const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const setup = (permalink?: MessagePermalink) => {
  const resolve = vi.fn(async () => chat)
  const around = vi.fn(async () => [{ ...message, anchor: true as const }])
  const native = vi.fn(async () => permalink as MessagePermalink)
  const adapter = {
    self: () => "500",
    resolve,
    around,
    ...(permalink ? { permalink: native } : {}),
  } as unknown as MessengerAdapter
  const connection = vi.fn(async () => adapter)
  const deps: ServiceDeps = {
    messenger,
    offline: false,
    guard,
    account: async () => account,
    connection,
    store: async () => {
      throw new Error("unexpected store")
    },
  }
  return { deps, connection, resolve, around, native, adapter, service: messagesService(deps) }
}

const stored = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "link-service-")), "m.db") })
  stores.push(store)
  await store.chats.saveChats(account, [chat])
  await store.messages.saveMessages(account, chat.id, [message], { via: "history" })
  return store
}

describe("message link service", () => {
  it.each(["public", "restricted", "unknown"] as const)("returns only link metadata for %s targets", async (access) => {
    const { service, native, around, resolve } = setup({
      url: "https://provider.example/post/12",
      access,
      reason: null,
    })
    const expected = {
      locator: "msg:test/500/7/9007199254740993123",
      url: "https://provider.example/post/12",
      access,
      reason: null,
    }
    expect(await service.link("Synthetic", message.id)).toEqual(expected)
    expect(await service.link(expected.locator)).toEqual(expected)
    expect(native).toHaveBeenCalledWith("7", message.id)
    expect(resolve).toHaveBeenCalledWith("7")
    expect(around).not.toHaveBeenCalled()
    expect(JSON.stringify(expected)).not.toContain(message.text)
  })

  it.each(["unsupported_chat", "unsupported_provider", "offline"] as const)(
    "preserves an explicit provider fallback: %s",
    async (reason) => {
      const { service } = setup({ url: null, access: "unavailable", reason })
      expect(await service.link("7", message.id)).toMatchObject({ url: null, access: "unavailable", reason })
    },
  )

  it("keeps provider extras out of output and cannot replace the account locator", async () => {
    const { service } = setup({
      url: "https://provider.example/1",
      access: "public",
      reason: null,
      locator: "msg:other/secret/7/1",
      text: "synthetic private body",
    } as MessagePermalink)
    expect(await service.link("7", message.id)).toEqual({
      locator: "msg:test/500/7/9007199254740993123",
      url: "https://provider.example/1",
      access: "public",
      reason: null,
    })
  })

  it("validates the target before fallback when no capability exists", async () => {
    const { service, around } = setup()
    expect(await service.link("Synthetic", message.id)).toEqual({
      locator: "msg:test/500/7/9007199254740993123",
      url: null,
      access: "unavailable",
      reason: "unsupported_provider",
    })
    expect(around).toHaveBeenCalledWith("7", message.id, { before: 0, after: 0 })
    around.mockResolvedValue([])
    await expect(service.link("7", "missing")).rejects.toMatchObject({ code: "not_found" })
  })

  it.each([
    ["msg:other/500/7/1", undefined],
    ["msg:test/other/7/1", undefined],
    ["msg:test/500/7/1", "2"],
    ["msg:test/500/7/%ZZ", undefined],
    ["msg:test/500/7", undefined],
    ["7", undefined],
    ["", "1"],
    ["7", ""],
    ["7", "a b"],
    ["7", "x".repeat(257)],
    ["msg:test/500/7/a%20b", undefined],
    ["7", String.fromCharCode(0)],
    ["7", String.fromCharCode(128)],
  ])("refuses invalid scope/address before connection: %s", async (chat, id) => {
    const { service, connection } = setup()
    await expect(service.link(chat as string, id)).rejects.toMatchObject({ code: "validation_error" })
    expect(connection).not.toHaveBeenCalled()
  })

  it("keeps account encoding and opaque ids intact", async () => {
    const { deps } = setup()
    deps.account = async () => ({ provider: "test", account: "account/one" })
    const adapter = await deps.connection()
    adapter.self = () => "account/one"
    adapter.resolve = async () => ({ ...chat, id: "room/one" })
    adapter.permalink = async () => ({ url: null, access: "unavailable", reason: "unsupported_chat" })
    expect(await messagesService(deps).link("msg:test/account%2Fone/room%2Fone/mid%2Fone")).toMatchObject({
      locator: "msg:test/account%2Fone/room%2Fone/mid%2Fone",
    })
  })

  it("rejects an account key for a different messenger", async () => {
    const { deps, connection } = setup()
    deps.account = async () => ({ provider: "other", account: "500" })
    await expect(messagesService(deps).link("7", "1")).rejects.toMatchObject({ code: "validation_error" })
    expect(connection).not.toHaveBeenCalled()
  })

  it.each([
    "bad URL",
    "http://provider.example/1",
    "https://user:secret@provider.example/1",
    "https://provider.example/1\n",
  ])("rejects unsafe provider links without echo: %s", async (url) => {
    const { service } = setup({ url, access: "public", reason: null })
    await expect(service.link("7", message.id)).rejects.toMatchObject({
      code: "validation_error",
      message: "the messenger returned an invalid permalink",
    })
  })

  it("rejects invalid access and fallback metadata", async () => {
    for (const result of [
      { url: null, access: "public", reason: null },
      { url: null, access: "unavailable", reason: "bad" },
      { url: "https://provider.example/1", access: "unavailable", reason: null },
      { url: "https://provider.example/1", access: "public", reason: "offline" },
    ]) {
      const { service } = setup(result as MessagePermalink)
      await expect(service.link("7", message.id)).rejects.toMatchObject({ code: "validation_error" })
    }
  })

  it("refuses a stale recorded account before target lookup", async () => {
    const { adapter, service, resolve, native } = setup({
      url: "https://provider.example/1",
      access: "public",
      reason: null,
    })
    adapter.self = () => "another"
    await expect(service.link("7", message.id)).rejects.toMatchObject({ code: "authentication_error" })
    expect(resolve).not.toHaveBeenCalled()
    expect(native).not.toHaveBeenCalled()
  })

  it("keeps provider denial as an error", async () => {
    const { adapter, service } = setup()
    adapter.permalink = async () => {
      throw new CliError("permission_error", "synthetic access denial")
    }
    await expect(service.link("7", message.id)).rejects.toMatchObject({ code: "permission_error" })
  })

  it("offline and pushed-history reads validate this account's record without connecting", async () => {
    const store = await stored()
    for (const offline of [true, false]) {
      const deps = {
        ...storedDeps(messenger, store, account, guard),
        offline,
        reads: "store" as const,
        connection: vi.fn(async () => {
          throw new Error("must not connect")
        }),
      }
      const service = messagesService(deps)
      expect(await service.link("Synthetic", message.id)).toMatchObject({
        locator: "msg:test/500/7/9007199254740993123",
        reason: offline ? "offline" : "unsupported_provider",
      })
      await expect(service.link("7", "missing")).rejects.toMatchObject({ code: "not_found" })
      await expect(service.link("404", "1")).rejects.toMatchObject({ code: "not_found" })
      expect(deps.connection).not.toHaveBeenCalled()
    }
    const service = messagesService(storedDeps(messenger, store, account, guard))
    expect(await service.link("7", message.id)).toMatchObject({ reason: "offline" })
    await expect(service.link("7", "missing")).rejects.toMatchObject({ code: "not_found" })
  })

  it("new capability passes through wrappers and observation does not record content or URLs", async () => {
    const { deps, adapter } = setup({ url: "https://provider.example/12", access: "restricted", reason: null })
    const events: unknown[] = []
    deps.connection = async () =>
      observed(throughWrapper(adapter, {} as MessengerAdapter), (event) => events.push(event))
    expect(await messagesService(deps).link("7", message.id)).toMatchObject({ access: "restricted" })
    const record = JSON.stringify(events)
    expect(record).toContain("permalink")
    expect(record).not.toContain(message.text)
    expect(record).not.toContain("provider.example")
  })
})
