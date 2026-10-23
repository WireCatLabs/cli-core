import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { GroupMember, Message } from "../domain/models.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import type { SendGuard } from "../sends/guard.js"
import { historyStartKey, type MessageStore, openStore } from "../store/store.js"
import { chatsService } from "./chats.js"
import { type ServiceDeps, storedDeps } from "./deps.js"

const account = { provider: "test", account: "500" }
const messenger = { provider: "test", chatArgument: "a chat", app: { command: "chat" } } as Messenger
const guard = {} as SendGuard

const member = (id: string, extra: Partial<GroupMember> = {}): GroupMember => ({
  id,
  name: `Person ${id.length > 3 ? "x" : id}`.replace(/\d/g, "n"),
  username: `user${id}`,
  role: "member",
  hasPhoto: true,
  isBot: false,
  joinedAt: null,
  invitedBy: null,
  ...extra,
})

const said = (id: string, senderId: string, text: string, extra: Partial<Message> = {}): Message => ({
  id,
  chatId: "7",
  senderId,
  senderName: null,
  timestamp: `2026-09-02T10:0${id}:00.000Z`,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...extra,
})

const opened: MessageStore[] = []
const heldStore = async (messages: Message[]) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "audit-")), "m.db") })
  opened.push(store)
  await store.chats.saveChats(account, [
    { id: "7", title: "Club", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 40 },
  ])
  if (messages.length > 0) await store.messages.saveMessages(account, "7", messages, { via: "test" })
  return store
}

const calls: string[] = []
const listing = (everyone: GroupMember[]) =>
  ({
    self: () => "500",
    members: async (_chat: string, { limit = 200, offset }: { limit?: number; offset: number }) => {
      calls.push(`members ${offset}`)
      return { chatId: "7", items: everyone.slice(offset, offset + limit), hasMore: offset + limit < everyone.length }
    },
  }) as unknown as MessengerAdapter

const online = (store: MessageStore, adapter: MessengerAdapter): ServiceDeps => ({
  ...storedDeps(messenger, store, account, guard),
  offline: false,
  connection: async () => adapter,
})

afterEach(async () => {
  calls.length = 0
  for (const store of opened.splice(0)) await store.close()
})

describe("chats members check", () => {
  it("lists bot-like members with reasons, leaving out the owner, admins and people who look real", async () => {
    const burst = ["31", "32", "33", "34", "35"].map((id, minute) =>
      member(id, { joinedAt: `2026-09-01T12:0${minute}:00.000Z`, invitedBy: "99" }),
    )
    const everyone = [
      member("500", { role: "owner" }),
      member("20", { role: "admin", isBot: true }),
      member("21"),
      member("22", { isBot: true }),
      member("23", { flagged: "scam", name: "Win 1000000 now", username: null }),
      member("24", { hasPhoto: false, username: null }),
      ...burst,
    ]
    const store = await heldStore([
      said("1", "21", "Hello all"),
      said("2", "24", "great offer https://example.test"),
      said("3", "22", "beep"),
      ...burst.map((one, index) => said(String(4 + index), one.id, "hi")),
    ])

    const audit = await chatsService(online(store, listing(everyone))).audit("Club", { pauseMs: 0 })

    expect(audit.items.map(({ id, score, reasons }) => ({ id, score, reasons }))).toEqual([
      { id: "23", score: 6, reasons: ["scam", "no_username", "odd_name", "never_wrote"] },
      { id: "24", score: 4, reasons: ["no_photo", "no_username", "link_first"] },
      { id: "22", score: 3, reasons: ["bot"] },
      { id: "31", score: 2, reasons: ["burst_join", "mass_invited"] },
      { id: "32", score: 2, reasons: ["burst_join", "mass_invited"] },
      { id: "33", score: 2, reasons: ["burst_join", "mass_invited"] },
      { id: "34", score: 2, reasons: ["burst_join", "mass_invited"] },
      { id: "35", score: 2, reasons: ["burst_join", "mass_invited"] },
    ])
    expect(audit).toMatchObject({ chatId: "7", read: 11, participantsCount: 40, more: false, unknown: ["deleted"] })
    expect(audit.fetch).toBe("chat messages sync 7")
    expect(calls).toEqual(["members 0"])
  })

  it("stops at the page budget and says some members were not read", async () => {
    const everyone = Array.from({ length: 450 }, (_, index) => member(String(1000 + index)))

    const audit = await chatsService(online(await heldStore([]), listing(everyone))).audit("7", {
      budget: 2,
      pauseMs: 0,
    })

    expect(calls).toEqual(["members 0", "members 200"])
    expect(audit).toMatchObject({ read: 400, more: true })
    expect(audit.unknown).toEqual(expect.arrayContaining(["never_wrote", "link_first"]))
  })

  it("names what the messenger did not say instead of judging on it", async () => {
    const bare = [{ id: "21", name: "Olga", username: null }]
    const adapter = { ...listing(bare as GroupMember[]) } as MessengerAdapter
    const store = await heldStore([said("1", "21", "hi")])
    await store.sync.markRange(account, "7", 1, 1)
    await store.sync.setSyncState(account, historyStartKey("7"), "1")

    const audit = await chatsService(online(store, adapter)).audit("7", { pauseMs: 0 })

    expect(audit.unknown).toEqual(["bot", "scam", "fake", "deleted", "no_photo", "burst_join", "mass_invited"])
    expect(audit.items).toEqual([])
    expect(audit).not.toHaveProperty("fetch")
  })

  it("refuses offline: the store holds no member lists", async () => {
    const deps = storedDeps(messenger, await heldStore([]), account, guard)

    await expect(chatsService(deps).audit("7", {})).rejects.toMatchObject({ code: "validation_error" })
  })
})
