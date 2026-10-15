import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import type { CallRecord, Chat, Message } from "../../domain/models.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { snakeKeys } from "../envelope.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { accountCommand } from "./account-command.js"
import { chatsCommand } from "./chats-command.js"
import type { Messenger } from "./context.js"
import { messagesCommand } from "./messages-command.js"
import { callsCommand, stickersCommand } from "./records-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const chat: Chat = {
  id: "7",
  title: "Book club",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: 3,
}
const message = (id: string): Message => ({
  id,
  chatId: "7",
  senderId: "9",
  senderName: null,
  text: "",
  timestamp: "2026-10-08T00:00:00.000Z",
  editedAt: null,
  outgoing: true,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})
const call: CallRecord = {
  id: "1",
  chatId: "7",
  callerId: "9",
  direction: "incoming",
  outcome: "missed",
  kind: "audio",
  at: "2026-10-08T00:00:00.000Z",
  durationSeconds: null,
}

const base: MessengerAdapter = {
  self: () => "500",
  me: async () => ({ id: "500", name: "Owner", username: null }),
  chats: async () => ({ items: [chat], hasMore: false }),
  history: async () => ({ items: [], hasMore: false }),
  resolve: async () => chat,
  chat: async () => ({ ...chat, members: null }),
  contact: async () => ({ id: "9", name: "Olga", username: null, description: null, lastMessagedAt: null, chats: [] }),
  around: async () => [],
  send: async () => {
    throw new Error("never sends")
  },
  logout: async () => {},
  close: async () => {},
}

const invoke = async (argv: string[], adapter: MessengerAdapter, own: Partial<Messenger> = {}, config?: object) => {
  const root = mkdtempSync(join(tmpdir(), "records-"))
  if (config) {
    mkdirSync(join(root, "c"), { recursive: true })
    writeFileSync(join(root, "c", "config.json"), JSON.stringify(config))
  }
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => adapter,
    chatArgument: "a chat",
    ...own,
  }
  const streams = captureStreams()
  const code = await run(
    argv,
    {
      app,
      commands: () => [
        chatsCommand(messenger),
        accountCommand(messenger),
        callsCommand(messenger),
        stickersCommand(messenger),
        messagesCommand(messenger),
      ],
    },
    {
      streams,
      tty: false,
      env: {
        CHAT_PROFILE: "default",
        CHAT_STATE_DIR: join(root, "s"),
        CHAT_CONFIG_DIR: join(root, "c"),
        MESSAGING_STORE: join(root, "m.db"),
      },
    },
  )
  return { code, stdout: streams.stdout.join(""), stderr: streams.stderr.join("") }
}

describe("reads only the server answers", () => {
  it("`chats media` asks for the kinds named, pages back by message id, and exists only where the messenger offers it", async () => {
    const asked: unknown[] = []
    const adapter: MessengerAdapter = {
      ...base,
      media: async (chatId, window) => {
        asked.push([chatId, window])
        return { items: [message("41"), message("42")], hasMore: true }
      },
    }
    const shown = await invoke(
      ["chats", "media", "Book club", "--type", "photo,link", "--limit", "2", "--cursor", "50", "--json"],
      adapter,
      { chatMedia: true },
    )
    const wrong = await invoke(["chats", "media", "Book club", "--type", "gif"], adapter, { chatMedia: true })
    const elsewhere = await invoke(["chats", "media", "Book club"], adapter)

    expect(JSON.parse(shown.stdout)).toMatchObject({
      items: [{ id: "41" }, { id: "42" }],
      page: { mode: "cursor", has_more: true, limit: 2, next_cursor: "41" },
      next: [{ step: "page.next", args: { chat: "Book club", type: "photo,link", cursor: "41", limit: 2 } }],
    })
    expect(asked).toEqual([["7", { kinds: ["photo", "link"], limit: 2, before: "50" }]])
    expect(wrong.code).toBe(2)
    expect(elsewhere.code).not.toBe(0)
  })

  it("`calls list` lists calls newest first, and says plainly when the messenger cannot", async () => {
    const listed = await invoke(["calls", "list", "--json"], {
      ...base,
      calls: async () => ({ items: [call], hasMore: false }),
    })
    const cannot = await invoke(["calls", "list"], base)

    expect(JSON.parse(listed.stdout)).toMatchObject({ items: [snakeKeys(call)], page: { has_more: false } })
    expect(cannot.stderr).toContain("cannot list calls")
  })

  it("`account privacy show` prints what the messenger reports, only where it offers it", async () => {
    const adapter: MessengerAdapter = { ...base, privacy: async () => ({ findByPhone: "contacts", hideOnline: false }) }
    const shown = await invoke(["account", "privacy", "show", "--json"], adapter, { privacy: true })
    const elsewhere = await invoke(["account", "privacy", "show"], adapter)

    expect(JSON.parse(shown.stdout).item).toEqual({ find_by_phone: "contacts", hide_online: false })
    expect(elsewhere.code).not.toBe(0)
  })

  it("`chats mute` mutes for good or until a time, `unmute` lifts it, each journaled as the owner's own change", async () => {
    const muted: unknown[] = []
    const adapter: MessengerAdapter = {
      ...base,
      mute: async (chatId, until) => {
        muted.push([chatId, until])
      },
    }
    const forever = await invoke(["chats", "mute", "Book club", "--json"], adapter, { chatMute: true })
    const timed = await invoke(["chats", "mute", "Book club", "--until", "2h", "--json"], adapter, { chatMute: true })
    const lifted = await invoke(["chats", "unmute", "Book club", "--json"], adapter, { chatMute: true })
    const past = await invoke(["chats", "mute", "Book club", "--until", "2020-01-01T00:00"], adapter, {
      chatMute: true,
    })

    expect(JSON.parse(forever.stdout).item).toMatchObject({ chat_id: "7", muted_until: "forever" })
    expect(JSON.parse(lifted.stdout).item).toMatchObject({ chat_id: "7", muted_until: null })
    expect(muted[0]).toEqual(["7", "forever"])
    expect(Date.parse(String((muted[1] as unknown[])[1])) - Date.now()).toBeGreaterThan(7_000_000)
    expect(muted[2]).toEqual(["7", null])
    expect([timed.code, past.code]).toEqual([0, 2])
    expect(muted).toHaveLength(3)
  })

  it("`account privacy set` sends only the settings named, and a read-only profile changes nothing", async () => {
    const changes: unknown[] = []
    const adapter: MessengerAdapter = {
      ...base,
      updatePrivacy: async (change) => {
        changes.push(change)
        return { findByPhone: "contacts", hideOnline: true }
      },
    }
    const set = await invoke(
      ["account", "privacy", "set", "--find-by-phone", "contacts", "--hide-online", "on", "--json"],
      adapter,
      { privacy: true },
    )
    const wrong = await invoke(["account", "privacy", "set", "--calls", "friends"], adapter, { privacy: true })
    const empty = await invoke(["account", "privacy", "set"], adapter, { privacy: true })
    const readOnly = await invoke(
      ["account", "privacy", "set", "--calls", "nobody"],
      adapter,
      { privacy: true },
      {
        defaults: { permissions: { account: "readonly" } },
        profiles: {},
      },
    )

    expect(JSON.parse(set.stdout).item).toMatchObject({ privacy: { find_by_phone: "contacts", hide_online: true } })
    expect(changes).toEqual([{ findByPhone: "contacts", hideOnline: true }])
    expect([wrong.code, empty.code, readOnly.code]).toEqual([2, 2, 5])
  })

  it("`stickers list` lists the sets, or one set's stickers", async () => {
    const adapter: MessengerAdapter = {
      ...base,
      stickerSets: async () => [{ id: "5", title: "Cats", count: 2, link: null }],
      stickers: async (setId) => [{ id: "51", setId, emoji: ["🐱"], url: null }],
    }
    const sets = await invoke(["stickers", "list", "--json"], adapter)
    const one = await invoke(["stickers", "list", "--set", "5", "--json"], adapter)

    expect(JSON.parse(sets.stdout)).toMatchObject({ items: [{ id: "5", title: "Cats" }], page: { has_more: false } })
    expect(JSON.parse(one.stdout).items).toEqual([{ id: "51", set_id: "5", emoji: ["🐱"], url: null }])
  })

  it("`messages send --sticker` sends it alone, refuses text beside it, and exists only where the messenger offers it", async () => {
    const sent: unknown[] = []
    const adapter: MessengerAdapter = {
      ...base,
      send: async (chatId, text, options) => {
        sent.push([chatId, text, options.sticker])
        return { message: { ...message("60"), chatId }, sendId: options.sendId }
      },
    }
    const ok = await invoke(["messages", "send", "Book club", "--sticker", "51", "--json"], adapter, { stickers: true })
    const withText = await invoke(["messages", "send", "Book club", "hi", "--sticker", "51"], adapter, {
      stickers: true,
    })
    const elsewhere = await invoke(["messages", "send", "Book club", "--sticker", "51"], adapter)

    expect(ok.code, ok.stderr).toBe(0)
    expect(sent).toEqual([["7", "", "51"]])
    expect(withText.code).toBe(2)
    expect(elsewhere.stderr).toContain("unknown option '--sticker'")
  })

  it("`chats delete` and `clear` ask first, go ahead with --allow-dangerous, and only where the messenger offers them", async () => {
    const done: unknown[] = []
    const adapter: MessengerAdapter = {
      ...base,
      deleteChat: async (chatId) => {
        done.push(["delete", chatId])
      },
      clearHistory: async (chatId) => {
        done.push(["clear", chatId])
      },
    }
    const own = { chatDeletion: true }
    const unasked = await invoke(["chats", "delete", "Book club"], adapter, own)
    const deleted = await invoke(["chats", "delete", "Book club", "--allow-dangerous", "--json"], adapter, own)
    const cleared = await invoke(["chats", "clear", "Book club", "--allow-dangerous", "--json"], adapter, own)
    const readOnly = await invoke(["chats", "clear", "Book club", "--allow-dangerous"], adapter, own, {
      defaults: { permissions: { chats: "readonly" } },
      profiles: {},
    })
    const elsewhere = await invoke(["chats", "delete", "Book club", "--allow-dangerous"], adapter)

    expect(unasked.stderr).toContain("--allow-dangerous")
    expect(JSON.parse(deleted.stdout).item).toMatchObject({ chat_id: "7" })
    expect(JSON.parse(cleared.stdout).item).toMatchObject({ chat_id: "7" })
    expect(done).toEqual([
      ["delete", "7"],
      ["clear", "7"],
    ])
    expect([unasked.code, readOnly.code]).toEqual([7, 5])
    expect(elsewhere.code).not.toBe(0)
  })
})
