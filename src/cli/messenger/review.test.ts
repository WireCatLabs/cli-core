import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import type { Chat, Message } from "../../domain/models.js"
import type { MessengerAdapter, ServerReads } from "../../ports/messenger.js"
import { reviewIn } from "../../services/inbox.js"
import { unanswered } from "../../services/questions.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import { reviewCommand } from "./review.js"

const app = {
  command: "chat",
  appName: "chat-cli",
  envPrefix: "CHAT",
  description: "A test messenger",
  version: "1.0.0",
}

const at = (minute: number) => new Date(Date.UTC(2026, 8, 28, 10, minute)).toISOString()

const chatAt = (id: string, minute: number, extra: Partial<Chat> = {}): Chat => ({
  id,
  title: `Chat ${id}`,
  kind: "group",
  unreadCount: 0,
  lastMessageAt: at(minute),
  participantsCount: 3,
  ...extra,
})

const said = (id: string, minute: number, text = "hola", extra: Partial<Message> = {}): Message => ({
  id,
  chatId: "1",
  senderId: extra.outgoing ? "500" : "9",
  senderName: null,
  timestamp: at(minute),
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
  ...extra,
})

/** `history` pages backwards by id, as Telegram's does: the newest `limit` older than `before`. */
const messengerWith = (chats: Chat[], histories: Record<string, Message[]>, admins?: string[] | null) => {
  const pages: string[] = []
  const adapter: MessengerAdapter & ServerReads = {
    self: () => "500",
    me: async () => ({ id: "500", name: "Owner", username: null }),
    chats: async () => ({ items: chats, hasMore: false }),
    history: async (chat, { limit, before }) => {
      pages.push(`${chat}<${before ?? ""}`)
      const all = histories[chat] ?? []
      const end = before === undefined ? all.length : all.findIndex((message) => message.id === before)
      return { items: all.slice(Math.max(0, end - limit), end), hasMore: end - limit > 0 }
    },
    resolve: async (reference) => chats.find((chat) => chat.title === reference) as Chat,
    chat: async () => ({ ...(chats[0] as Chat), members: [] }),
    contact: async () => ({ id: "9", name: null, username: null, description: null, lastMessagedAt: null, chats: [] }),
    around: async () => [],
    send: async () => {
      throw new Error("review never sends")
    },
    ...(admins === undefined ? {} : { admins: async () => admins }),
    logout: async () => {},
    close: async () => {},
  }
  return { adapter, pages }
}

describe("review", () => {
  it("reads both sides of every changed chat since the point, cut at the chat list's newest message", async () => {
    const { adapter } = messengerWith([chatAt("1", 5), chatAt("2", 1)], {
      "1": [said("10", 1), said("11", 3, "ok", { outgoing: true }), said("12", 5), said("13", 7)],
      "2": [said("20", 1)],
    })

    const found = await reviewIn(adapter, { since: Date.parse(at(2)) })

    expect(found.chats.map((chat) => [chat.id, chat.messages.map((one) => one.id)])).toEqual([["1", ["11", "12"]]])
    expect(found.until).toBe(at(5))
    expect(found.complete).toBe(true)
  })

  it("pages back until it passes the point, and cuts a busy chat short, keeping the newest", async () => {
    const busy = Array.from({ length: 450 }, (_, index) => said(String(index + 1), 30))
    const { adapter, pages } = messengerWith([chatAt("1", 30)], { "1": busy })

    const found = await reviewIn(adapter, { since: Date.parse(at(2)) })

    expect(pages).toEqual(["1<", "1<351", "1<251"])
    expect(found.chats[0]?.messages).toHaveLength(300)
    expect(found.chats[0]?.messages.at(-1)?.id).toBe("450")
    expect([found.chats[0]?.more, found.complete]).toEqual([true, false])
  })

  it("leaves out muted and archived chats unless all, but reads the one --chat names", async () => {
    const chats = [chatAt("1", 5, { muted: true }), chatAt("2", 5, { archived: true })]
    const { adapter } = messengerWith(chats, { "1": [said("10", 5)], "2": [said("20", 5)] })
    const since = Date.parse(at(2))

    const quiet = await reviewIn(adapter, { since })
    const all = await reviewIn(adapter, { since, all: true })
    const one = await reviewIn(adapter, { since, chat: "Chat 2" })

    expect([quiet.chats, quiet.quiet]).toEqual([[], 2])
    expect(all.chats).toHaveLength(2)
    expect(one.chats.map((chat) => chat.id)).toEqual(["2"])
  })

  it("--unanswered keeps the questions an admin did not answer, and says whose answers counted", async () => {
    const messages = [
      said("10", 3, "¿mañana?"),
      said("11", 4, "sí", { senderId: "7" }),
      said("12", 5, "¿y el lunes?"),
      said("13", 6, "hola", { senderId: "8" }),
    ]
    const since = Date.parse(at(2))
    const now = Date.parse(at(59)) + 48 * 3_600_000

    const withAdmins = await reviewIn(messengerWith([chatAt("1", 6)], { "1": messages }, ["7"]).adapter, {
      since,
      unansweredAfterHours: 24,
      now,
    })
    const unknown = await reviewIn(messengerWith([chatAt("1", 6)], { "1": messages }).adapter, {
      since,
      unansweredAfterHours: 24,
      now,
    })

    expect(withAdmins.chats[0]).toMatchObject({ answeredBy: "owner-and-admins", messages: [{ id: "12" }] })
    const hidden = await reviewIn(messengerWith([chatAt("1", 6)], { "1": messages }, null).adapter, {
      since,
      unansweredAfterHours: 24,
      now,
    })

    expect(unknown.chats[0]?.answeredBy).toBe("owner")
    expect(hidden.chats[0]?.answeredBy).toBe("owner")
    expect(unknown.chats[0]?.messages.map((one) => one.id)).toEqual(["10", "12"])
  })
})

describe("a question", () => {
  const before = Date.parse(at(59))
  const owner = new Set<string>()

  it("is a reply to the owner, found by id in the window, and not a link's query string", () => {
    const mine = said("10", 1, "the plan", { outgoing: true })
    const reply = said("11", 2, "done", { replyToId: "10" })
    const link = said("12", 3, "https://example.com/?a=1")

    expect(unanswered([mine, reply, link], { answerers: owner, before }).map((one) => one.id)).toEqual(["11"])
  })

  it("is answered by the owner replying to it, even after somebody else spoke", () => {
    const asked = said("10", 1, "¿vienes?")
    const other = said("11", 2, "yo sí", { senderId: "8" })
    const answer = said("12", 3, "voy", { outgoing: true, replyToId: "10" })

    expect(unanswered([asked, other, answer], { answerers: owner, before })).toEqual([])
  })

  it("is not due before its hours are up", () => {
    expect(unanswered([said("10", 1, "¿vienes?")], { answerers: owner, before: Date.parse(at(0)) })).toEqual([])
  })
})

describe("review, the command", () => {
  const recent = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const latest = recent(60)
  const scripted = messengerWith([{ ...chatAt("1", 0), title: "Valencia", lastMessageAt: latest, muted: true }], {
    "1": [
      { ...said("10", 0, "¿vienes?"), timestamp: recent(60 * 30) },
      { ...said("11", 0), timestamp: latest },
    ],
  })
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => scripted.adapter,
    chatArgument: "a chat",
  }
  const review = async (argv: string[]) => {
    const root = mkdtempSync(join(tmpdir(), "review-"))
    const streams = captureStreams()
    const env = {
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "s"),
      CHAT_CONFIG_DIR: join(root, "c"),
      MESSAGING_STORE: join(root, "m.db"),
    }
    const code = await run(
      ["review", ...argv, "--json"],
      { app, commands: () => [reviewCommand(messenger)] },
      {
        streams,
        tty: false,
        env,
      },
    )
    return { code, answer: JSON.parse(streams.stdout[0] ?? "null"), stderr: streams.stderr.join("\n") }
  }

  const ids = (answer: { items: { ref: string }[] }) => answer.items.map((one) => one.ref.split("/").at(-1))

  it("reads from a date, --all takes in a muted chat, and its review.next step goes on without a gap or a repeat", async () => {
    const quiet = await review(["date>2d"])
    const all = await review(["date>2d", "--all"])

    expect(quiet.answer.items).toEqual([])
    expect(quiet.answer.missing).toContainEqual(expect.objectContaining({ step: "review.all" }))
    expect(ids(all.answer)).toEqual(["10", "11"])
    const [next] = all.answer.next
    expect(next).toMatchObject({ step: "review.next", args: { query: expect.stringMatching(/^date>"/) } })
    const after = await review([next.args.query, "--all"])
    expect(after.code).toBe(0)
    expect(after.answer.items).toEqual([])
  })

  it("narrows to one chat by chat: and to its open questions with --unanswered; no review.next then", async () => {
    const { code, answer } = await review(["chat:Valencia", "--unanswered", "12h"])

    expect(code).toBe(0)
    expect(ids(answer)).toEqual(["10"])
    expect(answer.next ?? []).not.toContainEqual(expect.objectContaining({ step: "review.next" }))
  })

  it("starts the next review where this one started when voice messages were left unheard", async () => {
    const message = scripted.adapter.history
    scripted.adapter.history = async (...args) => {
      const page = await message(...args)
      return { ...page, items: page.items.map((one) => ({ ...one, attachments: [{ kind: "voice" as const }] })) }
    }
    try {
      const result = await review(['date>"2026-01-01T00:00:00.000Z"', "--all"])
      expect(result.code).toBe(0)
      expect(result.answer.items[0].attachments).toHaveLength(1)
      expect(result.answer.next[0].args.query).toBe('date>"2026-01-01T00:00:00.000Z"')
    } finally {
      scripted.adapter.history = message
    }
  })

  it("--transcribe says which voice messages stay unheard; --model alone is refused", async () => {
    const heard = await review(["date>2d", "--all", "--transcribe"])
    const lonely = await review(["date>2d", "--model", "gigaam-v3"])

    expect(heard.code).toBe(0)
    expect(heard.answer.missing ?? []).not.toContainEqual(expect.objectContaining({ field: "transcript" }))
    expect(lonely.code).toBe(2)
  })
})
