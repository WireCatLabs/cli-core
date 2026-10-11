import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import type { Chat, Message } from "../../domain/models.js"
import { INBOX_CHATS, kindsOf, newIn, reviewIn, unreadIn } from "../../services/inbox.js"
import { momentOf } from "../../services/moment.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import { inboxCommand } from "./inbox.js"
import type { MessengerAdapter, ServerReads } from "./port.js"
import { reviewCommand } from "./review.js"

const app = {
  command: "chat",
  appName: "chat-cli",
  envPrefix: "CHAT",
  description: "A test messenger",
  version: "1.0.0",
}

const at = (minute: number) => new Date(Date.UTC(2026, 8, 28, 10, minute)).toISOString()

const chatAt = (id: string, minute: number, unreadCount = 0): Chat => ({
  id,
  title: `Chat ${id}`,
  kind: "group",
  unreadCount,
  lastMessageAt: at(minute),
  participantsCount: 3,
})

const messageAt = (chatId: string, id: string, minute: number, outgoing = false): Message => ({
  id,
  chatId,
  senderId: outgoing ? "500" : "9",
  senderName: outgoing ? "Owner" : "Olga",
  timestamp: at(minute),
  editedAt: null,
  text: `message ${id}`,
  outgoing,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

/** A messenger whose chats and histories are given; `history` answers each chat's newest `limit`. */
const messengerWith = (chats: Chat[], histories: Record<string, Message[]>) => {
  const read: string[] = []
  const marks: [string, string | undefined][] = []
  const adapter: MessengerAdapter & ServerReads = {
    self: () => "500",
    me: async () => ({ id: "500", name: "Owner", username: null }),
    chats: async ({ limit, offset }) => ({
      items: chats.slice(offset, limit === undefined ? undefined : offset + limit),
      hasMore: limit !== undefined && chats.length > offset + limit,
    }),
    history: async (chat, { limit }) => {
      read.push(chat)
      return { items: (histories[chat] ?? []).slice(-limit), hasMore: false }
    },
    resolve: async (reference) => chats.find((chat) => chat.id === reference) ?? (chats[0] as Chat),
    markRead: async (chatId, until) => {
      marks.push([chatId, until])
    },
    chat: async () => ({ ...(chats[0] as Chat), members: [] }),
    contact: async () => ({ id: "9", name: null, username: null, description: null, lastMessagedAt: null, chats: [] }),
    around: async () => [],
    send: async () => {
      throw new Error("inbox never sends")
    },
    logout: async () => {},
    close: async () => {},
  }
  return { adapter, read, marks }
}

describe("the unread inbox", () => {
  it("reads each chat's unread messages, newest chats first, and leaves out the owner's own", async () => {
    const { adapter } = messengerWith([chatAt("1", 5, 2), chatAt("2", 9, 1), chatAt("3", 8, 0)], {
      "1": [messageAt("1", "10", 1), messageAt("1", "11", 4, true), messageAt("1", "12", 5)],
      "2": [messageAt("2", "20", 9)],
    })

    const inbox = await unreadIn(adapter, { limit: 20 })

    expect(inbox.chats.map((chat) => [chat.id, chat.messages.map((one) => one.id)])).toEqual([
      ["2", ["20"]],
      ["1", ["12"]],
    ])
  })

  it(`reads at most ${INBOX_CHATS} chats, and names the rest`, async () => {
    const chats = Array.from({ length: INBOX_CHATS + 2 }, (_, index) => chatAt(String(index), 59 - index, 1))
    const histories = Object.fromEntries(chats.map((chat) => [chat.id, [messageAt(chat.id, "1", 1)]]))
    const { adapter, read } = messengerWith(chats, histories)

    const inbox = await unreadIn(adapter, { limit: 20 })

    expect(read).toHaveLength(INBOX_CHATS)
    expect(inbox.skipped.map((chat) => chat.id)).toEqual([String(INBOX_CHATS), String(INBOX_CHATS + 1)])
  })

  it("keeps only the kinds asked for, before the cap, so a busy kind does not crowd out another", async () => {
    const groups = Array.from({ length: INBOX_CHATS + 2 }, (_, index) => chatAt(String(index), 59 - index, 1))
    const channel = { ...chatAt("c", 0, 1), kind: "channel" as const }
    const chats = [...groups, channel]
    const histories = Object.fromEntries(chats.map((chat) => [chat.id, [messageAt(chat.id, "1", 0)]]))
    const { adapter, read } = messengerWith(chats, histories)

    const inbox = await unreadIn(adapter, { limit: 20, kinds: ["channel"] })

    expect(read).toEqual(["c"])
    expect(inbox.skipped).toEqual([])
  })

  it("leaves out muted and archived chats unless they mention the owner, and counts them", async () => {
    const chats = [
      { ...chatAt("1", 5, 1), muted: true },
      { ...chatAt("2", 4, 1), archived: true },
      { ...chatAt("3", 3, 1), muted: true, unreadMentions: 1 },
      { ...chatAt("4", 2, 1), muted: false },
    ]
    const histories = Object.fromEntries(chats.map((chat) => [chat.id, [messageAt(chat.id, "1", 1)]]))
    const { adapter, read } = messengerWith(chats, histories)

    const inbox = await unreadIn(adapter, { limit: 20 })

    expect(read).toEqual(["3", "4"])
    expect(inbox.quiet).toBe(2)
    expect((await unreadIn(adapter, { limit: 20, all: true })).chats).toHaveLength(4)
  })
})

describe("every chat, not only the newest", () => {
  const since = Date.parse(at(0))
  const asking = (chats: Chat[], histories: Record<string, Message[]>, hasMore = false) => {
    const scripted = messengerWith(chats, histories)
    const asked: unknown[] = []
    const adapter: MessengerAdapter & ServerReads = {
      ...scripted.adapter,
      chats: async (window) => {
        asked.push(window)
        return { ...(await scripted.adapter.chats(window)), hasMore }
      },
    }
    return { adapter, asked, read: scripted.read }
  }

  it("finds an unread chat far down a list sorted by the last message, in one call for every chat", async () => {
    const quiet = Array.from({ length: 150 }, (_, index) => chatAt(`q${index}`, 59))
    const { adapter, asked } = asking([...quiet, chatAt("far", 1, 1)], { far: [messageAt("far", "1", 1)] })

    const inbox = await unreadIn(adapter, { limit: 20 })

    expect(inbox.chats.map((chat) => chat.id)).toEqual(["far"])
    expect(asked).toEqual([{ offset: 0 }])
    expect(inbox.partial).toBe(false)
  })

  it("reads changed chats behind an old pinned one, and names the ones past the cap", async () => {
    const pinned = chatAt("pinned", 0)
    const changed = Array.from({ length: 120 }, (_, index) => chatAt(`c${index}`, 50))
    const histories = Object.fromEntries(changed.map((chat) => [chat.id, [messageAt(chat.id, "1", 50)]]))
    const { adapter } = asking([pinned, ...changed], histories)

    const fresh = await newIn(adapter, { since, limit: 20 })
    const review = await reviewIn(adapter, { since })

    expect(fresh.chats.length + fresh.skipped.length).toBe(120)
    expect(review.chats.length + review.skipped.length).toBe(120)
    expect([fresh.partial, review.partial]).toEqual([false, false])
  })

  it("is partial only when the messenger says it could not list every chat", async () => {
    const { adapter } = asking([chatAt("1", 5, 1)], { "1": [messageAt("1", "1", 5)] }, true)

    const unread = await unreadIn(adapter, { limit: 20 })
    const fresh = await newIn(adapter, { since, limit: 20 })
    const review = await reviewIn(adapter, { since })

    expect([unread.partial, fresh.partial, review.partial, review.complete]).toEqual([true, true, true, false])
  })
})

describe("what is new since a moment", () => {
  it("cuts at the chat list's newest message, so a message arriving during the reads waits for the next run", async () => {
    const histories = {
      "1": [messageAt("1", "10", 3)],
      // Arrived after the chat list was taken: newer than any chat's last message in it.
      "2": [messageAt("2", "20", 5), messageAt("2", "21", 7)],
    }
    const { adapter } = messengerWith([chatAt("1", 3), chatAt("2", 5)], histories)

    const inbox = await newIn(adapter, { since: Date.parse(at(2)), limit: 20 })

    expect(inbox.chats.flatMap((chat) => chat.messages.map((one) => one.id))).toEqual(["20", "10"])
    expect(inbox.until).toBe(at(5))
  })

  it("reads no chat whose last message is older than the moment", async () => {
    const { adapter, read } = messengerWith([chatAt("1", 3), chatAt("2", 1)], { "1": [messageAt("1", "10", 3)] })

    await newIn(adapter, { since: Date.parse(at(2)), limit: 20 })

    expect(read).toEqual(["1"])
  })

  it("leaves out a muted chat that changed, unless all", async () => {
    const histories = { "1": [messageAt("1", "10", 3)], "2": [messageAt("2", "20", 4)] }
    const { adapter } = messengerWith([chatAt("1", 3), { ...chatAt("2", 4), muted: true }], histories)

    const quietly = await newIn(adapter, { since: Date.parse(at(2)), limit: 20 })
    const everything = await newIn(adapter, { since: Date.parse(at(2)), limit: 20, all: true })

    expect(quietly.chats.map((chat) => chat.id)).toEqual(["1"])
    expect(quietly.quiet).toBe(1)
    expect(everything.chats.map((chat) => chat.id)).toEqual(["2", "1"])
  })
})

describe("a point per chat", () => {
  it("starts each chat from its own point, and from since where it has none", async () => {
    const histories = { "1": [messageAt("1", "10", 3), messageAt("1", "11", 6)], "2": [messageAt("2", "20", 4)] }
    const { adapter } = messengerWith([chatAt("1", 6), chatAt("2", 4)], histories)

    const inbox = await newIn(adapter, {
      since: Date.parse(at(2)),
      points: new Map([["1", Date.parse(at(5))]]),
      limit: 20,
    })

    expect(inbox.chats.map((chat) => [chat.id, chat.messages.map((one) => one.id)])).toEqual([
      ["1", ["11"]],
      ["2", ["20"]],
    ])
    expect(inbox.checked).toEqual({ "1": at(6), "2": at(6) })
  })

  it("checks only the chats it read: other kinds and chats past the cap keep their point", async () => {
    const histories = { g: [messageAt("g", "1", 4)], c: [messageAt("c", "2", 5)] }
    const { adapter } = messengerWith([chatAt("g", 4), { ...chatAt("c", 5), kind: "channel" }], histories)

    const inbox = await newIn(adapter, { since: Date.parse(at(2)), limit: 20, kinds: ["channel"] })

    expect(inbox.checked).toEqual({ c: at(5) })
  })
})

describe("a review's points", () => {
  it("checks a chat read whole, and leaves one cut short where it was", async () => {
    const busy = Array.from({ length: 400 }, (_, index) => ({
      ...messageAt("busy", String(index), 0),
      timestamp: new Date(Date.UTC(2026, 8, 28, 10, 30) + index * 1000).toISOString(),
    }))
    const { adapter } = messengerWith([{ ...chatAt("busy", 40) }, chatAt("calm", 5)], {
      calm: [messageAt("calm", "1", 5)],
    })
    const paged = {
      ...adapter,
      history: async (chat: string, { limit, before }: { limit: number; before?: string }) => {
        if (chat !== "busy") return adapter.history(chat, { limit })
        const end = before === undefined ? busy.length : Number(before)
        return { items: busy.slice(Math.max(0, end - limit), end), hasMore: end - limit > 0 }
      },
    }

    const review = await reviewIn(paged, { since: Date.parse(at(2)), points: new Map() })

    expect(review.chats.find((chat) => chat.id === "busy")?.more).toBe(true)
    expect(Object.keys(review.checked ?? {})).toEqual(["calm"])
  })
})

describe("--kind", () => {
  it("takes kinds comma-separated and refuses anything else", () => {
    expect(kindsOf("dialog, group")).toEqual(["dialog", "group"])
    expect(() => kindsOf("groups")).toThrow(/dialog, group, channel, saved/)
    expect(() => kindsOf(",")).toThrow(/--kind/)
  })

  it("narrows a review to those kinds", async () => {
    const histories = { g: [messageAt("g", "1", 4)], c: [messageAt("c", "2", 5)] }
    const { adapter, read } = messengerWith([chatAt("g", 4), { ...chatAt("c", 5), kind: "channel" }], histories)

    const review = await reviewIn(adapter, { since: Date.parse(at(2)), kinds: ["group"] })

    expect(review.chats.map((chat) => chat.id)).toEqual(["g"])
    expect(read).toEqual(["g"])
  })
})

describe("--since", () => {
  it("takes an ISO time or 30m, 2h, 1d ago, and refuses a message id", () => {
    const now = Date.parse("2026-09-28T12:00:00Z")
    expect(momentOf("2026-09-28T10:00:00Z", "--since", now)).toBe(Date.parse("2026-09-28T10:00:00Z"))
    expect(momentOf("2h", "--since", now)).toBe(Date.parse("2026-09-28T10:00:00Z"))
    expect(momentOf("1d", "--since", now)).toBe(Date.parse("2026-09-27T12:00:00Z"))
    expect(() => momentOf("12345")).toThrow(/ISO 8601/)
  })
})

describe("inbox --new", () => {
  const setup = (histories: Record<string, Message[]>, chats: Chat[]) => {
    const root = mkdtempSync(join(tmpdir(), "inbox-"))
    const env = {
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
      MESSAGING_STORE: join(root, "m.db"),
      CHAT_REQUESTS_PER_MINUTE: "0",
    }
    const scripted = messengerWith(chats, histories)
    let failing = false
    const messenger: Messenger = {
      app,
      provider: "chat",
      resolveSettings: settingsFor(app).resolveSettings,
      connect: async () =>
        failing
          ? {
              ...scripted.adapter,
              history: async () => {
                throw new Error("the connection dropped")
              },
            }
          : scripted.adapter,
      chatArgument: "a chat",
    }
    const command = (name: "inbox" | "review") => async (argv: string[]) => {
      const streams = captureStreams()
      const code = await run(
        [name, ...argv, "--json"],
        { app, commands: () => [inboxCommand(messenger), reviewCommand(messenger)] },
        {
          streams,
          tty: false,
          env,
        },
      )
      return {
        code,
        answer: streams.stdout[0] ? JSON.parse(streams.stdout[0]) : undefined,
        stderr: streams.stderr.join("\n"),
      }
    }
    const inbox = command("inbox")
    const review = command("review")
    const pointFile = join(env.CHAT_STATE_DIR, "inbox", "default.json")
    return {
      inbox,
      review,
      marks: scripted.marks,
      configure: (profile: unknown) => {
        mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
        writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify({ profiles: { default: profile } }))
      },
      fail: (on: boolean) => {
        failing = on
      },
      saved: () => JSON.parse(readFileSync(pointFile, "utf8")),
      save: (points: unknown) => {
        mkdirSync(join(env.CHAT_STATE_DIR, "inbox"), { recursive: true })
        writeFileSync(pointFile, JSON.stringify(points))
      },
    }
  }

  const startedAt = Date.now()
  const minutesAgo = (minutes: number) => new Date(startedAt - minutes * 60_000).toISOString()
  const recentChat = (id: string, minutes: number, kind: Chat["kind"] = "group"): Chat => ({
    ...chatAt(id, 0),
    kind,
    lastMessageAt: minutesAgo(minutes),
  })
  const recentMessage = (chat: string, minutes: number): Message => ({
    ...messageAt(chat, `${chat}-1`, 0),
    timestamp: minutesAgo(minutes),
  })

  it("shows each message once: a second run starts where the first one printed up to", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString()
    const chat = { ...chatAt("1", 0), lastMessageAt: recent }
    const { inbox } = setup({ "1": [{ ...messageAt("1", "10", 0), timestamp: recent }] }, [chat])

    const first = await inbox(["--new"])
    const second = await inbox(["--new"])

    expect(first.answer.chats.map((one: { id: string }) => one.id)).toEqual(["1"])
    expect(second.answer.chats).toEqual([])
    expect(second.answer.since).toBe(recent)
  })

  it(`loses nothing past the first ${INBOX_CHATS} chats: the next run shows the ones skipped`, async () => {
    const chats = Array.from({ length: INBOX_CHATS + 2 }, (_, index) => recentChat(`c${index}`, index + 1))
    const histories = Object.fromEntries(chats.map((chat, index) => [chat.id, [recentMessage(chat.id, index + 1)]]))
    const { inbox } = setup(histories, chats)

    const first = await inbox(["--new"])
    const second = await inbox(["--new"])

    expect(first.answer.chats).toHaveLength(INBOX_CHATS)
    expect(second.answer.chats.map((one: { id: string }) => one.id)).toEqual([`c${INBOX_CHATS}`, `c${INBOX_CHATS + 1}`])
  })

  it("says how many chats it skipped, and which", async () => {
    const chats = Array.from({ length: INBOX_CHATS + 2 }, (_, index) => recentChat(`c${index}`, index + 1))
    const histories = Object.fromEntries(chats.map((chat, index) => [chat.id, [recentMessage(chat.id, index + 1)]]))
    const { inbox, review } = setup(histories, chats)

    const fresh = await inbox(["--new"])
    const reviewed = await review(["--since-time", "1d"])

    expect(fresh.stderr).toContain(`skipped 2 chats — too many at once: Chat c${INBOX_CHATS}, Chat c${INBOX_CHATS + 1}`)
    expect(reviewed.stderr).toContain("skipped 2 chats — too many at once")
  })

  it("a channels-only run leaves the groups for the next run", async () => {
    const chats = [recentChat("g", 2), recentChat("c", 1, "channel")]
    const { inbox } = setup({ g: [recentMessage("g", 2)], c: [recentMessage("c", 1)] }, chats)

    const channels = await inbox(["--new", "--kind", "channel"])
    const groups = await inbox(["--new", "--kind", "group"])

    expect(channels.answer.chats.map((one: { id: string }) => one.id)).toEqual(["c"])
    expect(groups.answer.chats.map((one: { id: string }) => one.id)).toEqual(["g"])
  })

  it("reads the single point older versions kept, and keeps it as where unread chats start", async () => {
    const point = minutesAgo(10)
    const { inbox, save, saved } = setup({ g: [recentMessage("g", 5)] }, [recentChat("g", 5)])
    save({ lastCheckAt: point })

    const { answer } = await inbox(["--new"])

    expect(answer.since).toBe(point)
    expect(saved()).toEqual({ lastCheckAt: point, chats: { g: answer.until } })
  })

  it("--all takes in muted and archived chats", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString()
    const chat = { ...chatAt("1", 0), lastMessageAt: recent, archived: true }
    const { inbox } = setup({ "1": [{ ...messageAt("1", "10", 0), timestamp: recent }] }, [chat])

    expect((await inbox(["--since-time", "1d"])).answer.chats).toEqual([])
    expect((await inbox(["--since-time", "1d", "--all"])).answer.chats).toHaveLength(1)
  })

  it("looks back 24 hours the first time", async () => {
    const { inbox } = setup({}, [])

    const { answer } = await inbox(["--new"])

    expect(Date.now() - Date.parse(answer.since)).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 5000)
  })

  it("leaves the saved point alone after a run that failed, or one given --since", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString()
    const chat = { ...chatAt("1", 0), lastMessageAt: recent }
    const { inbox, fail } = setup({ "1": [{ ...messageAt("1", "10", 0), timestamp: recent }] }, [chat])

    fail(true)
    expect((await inbox(["--new"])).code).not.toBe(0)
    fail(false)
    expect((await inbox(["--new", "--since-time", "1d"])).answer.chats).toHaveLength(1)
    const { answer } = await inbox(["--new"])

    expect(answer.chats.map((one: { id: string }) => one.id)).toEqual(["1"])
  })

  it("review --new keeps its own points: an inbox --new run does not move them", async () => {
    const chats = [recentChat("g", 2)]
    const { inbox, review } = setup({ g: [recentMessage("g", 2)] }, chats)

    await inbox(["--new"])
    const first = await review(["--new"])
    const second = await review(["--new"])

    expect(first.answer.chats.map((one: { id: string }) => one.id)).toEqual(["g"])
    expect(second.answer.chats).toEqual([])
  })

  it("review --new refuses --since-time and --unanswered: it keeps its own point", async () => {
    const { review } = setup({}, [])

    expect((await review(["--new", "--since-time", "1d"])).code).toBe(2)
    expect((await review(["--new", "--unanswered"])).code).toBe(2)
  })

  it("marks read only when asked — up to the newest message shown — or when the setting says so", async () => {
    const chats = [recentChat("g", 2), recentChat("d", 1, "dialog")]
    const { inbox, review, marks, configure } = setup({ g: [recentMessage("g", 2)], d: [recentMessage("d", 1)] }, chats)

    await inbox(["--since-time", "1d"])
    expect(marks).toEqual([])
    const asked = await inbox(["--since-time", "1d", "--kind", "dialog", "--mark-read"])
    expect(marks).toEqual([["d", "d-1"]])
    expect(asked.answer.markedRead).toEqual([{ chatId: "d", until: "d-1" }])

    configure({ catchUpMarksRead: true })
    await review(["--since-time", "1d", "--kind", "group"])
    await inbox(["--since-time", "1d", "--no-mark-read"])
    expect(marks).toEqual([
      ["d", "d-1"],
      ["g", "g-1"],
    ])
    expect((await inbox(["--since-time", "1d", "--mark-read", "--offline"])).code).toBe(2)
  })
})
