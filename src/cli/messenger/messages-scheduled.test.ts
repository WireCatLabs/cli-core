import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { captureStreams } from "@wirecat/cli-base"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import type { Chat, Message } from "../../domain/models.js"
import { ENTITIES } from "../../entities/index.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { SendJournal, sendsPathFor } from "../../sends/journal.js"
import { type RunOptions, run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import { messagesCommand } from "./messages-command.js"

const app = {
  command: "chat",
  appName: "chat-cli",
  envPrefix: "CHAT",
  description: "A test messenger",
  version: "1.0.0",
}
const chat: Chat = {
  id: "7",
  title: "Book club",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: "2026-09-27T10:00:00.000Z",
  participantsCount: 4,
}
const message: Message = {
  id: "3",
  chatId: "7",
  senderId: "500",
  senderName: "Owner",
  timestamp: "2026-09-27T10:00:00.000Z",
  editedAt: null,
  text: "old group post",
  outgoing: true,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
}
const WHEN = "2030-01-01T09:00:00.000Z"
const waiting: Message = { ...message, id: "12", text: "see you tonight", scheduledFor: WHEN }

/** A chat whose history holds message 3 and whose scheduled list holds 12, as Telegram keeps two id spaces. */
const queue = () => {
  const calls: unknown[][] = []
  let list = [waiting]
  const adapter: MessengerAdapter = {
    self: () => "500",
    me: async () => ({ id: "500", name: "Owner", username: null }),
    chats: async () => ({ items: [chat], hasMore: false }),
    history: async () => ({ items: [message], hasMore: false }),
    resolve: async () => chat,
    chat: async () => ({ ...chat, members: [] }),
    send: async () => ({ message, sendId: "1" }),
    logout: async () => {},
    close: async () => {},
    scheduled: async () => list,
    cancelScheduled: async (chatId, ids) => {
      calls.push(["cancel", chatId, ids])
      list = list.filter((one) => !ids.includes(one.id))
    },
    editScheduled: async (chatId, id, change) => {
      calls.push(["edit", chatId, id, change])
      return { ...waiting, text: change.text ?? waiting.text, scheduledFor: change.at }
    },
    sendScheduled: async (chatId, ids) => {
      calls.push(["send", chatId, ids])
      return ids.map((_, index) => ({ ...waiting, id: String(40 + index), scheduledFor: undefined }))
    },
  }
  return { adapter, calls }
}

const setup = (permissions: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "scheduled-"))
  const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), CHAT_CONFIG_DIR: join(root, "config") }
  mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
  writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify({ profiles: { default: { permissions } } }))
  return env
}

const call = async (
  argv: string[],
  adapter: MessengerAdapter,
  env: NodeJS.ProcessEnv,
  options: Partial<RunOptions> = {},
  own: Partial<Messenger> = {},
) => {
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
    { app, commands: () => [messagesCommand(messenger)] },
    { streams, tty: false, env, keyring: memoryKeyring(), ...options },
  )
  return { code, stdout: streams.stdout, stderr: streams.stderr.join("\n") }
}

const itemOf = (result: { stdout: string[] }) => JSON.parse(result.stdout[0] ?? "").item
const errorOf = (result: { stderr: string }) => JSON.parse(result.stderr.split("\n")[0] ?? "").error
const piped = (text: string) => ({ stdin: Object.assign(Readable.from([text]), { isTTY: false }) })

describe("actions on scheduled messages", () => {
  it("**still lists the queue** under the group that now holds the actions", async () => {
    const { adapter } = queue()
    const listed = await call(["messages", "scheduled", "Book club", "--json"], adapter, setup())

    expect(listed.code).toBe(0)
    expect(JSON.parse(listed.stdout[0] ?? "").items).toMatchObject([{ id: "12", scheduled_for: WHEN }])
  })

  it("**cancels by the scheduled id**, journals it as a deletion, and refuses a sent message's id before any write", async () => {
    const { adapter, calls } = queue()
    const env = setup()

    const sentId = await call(["messages", "scheduled", "cancel", "Book club", "3"], adapter, env)
    const cancelled = await call(["messages", "scheduled", "cancel", "Book club", "12", "--json"], adapter, env)

    expect(sentId.code).not.toBe(0)
    expect(errorOf(sentId)).toMatchObject({ code: "not_found" })
    expect(errorOf(sentId).message).toContain("messages scheduled Book club")
    expect(cancelled.code).toBe(0)
    const answer = itemOf(cancelled)
    expect(v.safeParse(ENTITIES.scheduled_cancellation, answer).success).toBe(true)
    expect(answer).toEqual({ operation_id: expect.any(String), chat_id: "7", cancelled: ["12"] })
    expect(calls).toEqual([["cancel", "7", ["12"]]])
    expect(new SendJournal(sendsPathFor(app, "default", env)).entries()).toMatchObject([
      { outcome: "sent", kind: "delete", key: "messages.scheduled.cancel", count: 1 },
    ])
  })

  it("**asks before a cancel at ask**, as a delete does: --allow-dangerous is the yes; read-only messages stop it", async () => {
    const { adapter, calls } = queue()
    const env = setup({ "messages.scheduled.cancel": "ask" })

    const unasked = await call(["messages", "scheduled", "cancel", "Book club", "12"], adapter, env)
    const agreed = await call(["messages", "scheduled", "cancel", "Book club", "12", "--allow-dangerous"], adapter, env)
    const denied = await call(
      ["messages", "scheduled", "cancel", "Book club", "12"],
      adapter,
      setup({ messages: "readonly" }),
    )

    expect(unasked.code).not.toBe(0)
    expect(unasked.stderr).toContain("--allow-dangerous")
    expect(agreed.code).toBe(0)
    expect(denied.code).not.toBe(0)
    expect(calls).toEqual([["cancel", "7", ["12"]]])
  })

  it("**edits the text and keeps the time**, so the messenger reads the id as a scheduled one", async () => {
    const { adapter, calls } = queue()

    const edited = await call(
      ["messages", "scheduled", "edit", "Book club", "12", "see you at eight", "--json"],
      adapter,
      setup(),
    )

    expect(edited.code).toBe(0)
    expect(calls).toEqual([["edit", "7", "12", { at: WHEN, text: "see you at eight" }]])
    const answer = JSON.parse(edited.stdout[0] ?? "")
    expect(v.safeParse(ENTITIES.message_write, answer.item).success).toBe(true)
    expect(answer.item).toMatchObject({ scheduled_for: WHEN, message: { text: "see you at eight" } })
    expect(answer.next).toMatchObject([{ command: "messages scheduled", args: { chat: "7" } }])
  })

  it("**moves only the time with --at-time**, reading no stdin, and refuses an edit that changes nothing", async () => {
    const { adapter, calls } = queue()
    const env = setup()

    const moved = await call(
      ["messages", "scheduled", "edit", "Book club", "12", "--at-time", "2h", "--json"],
      adapter,
      env,
      piped("must not be read"),
    )
    const nothing = await call(["messages", "scheduled", "edit", "Book club", "12"], adapter, env, piped(""))
    const unknown = await call(["messages", "scheduled", "edit", "Book club", "3", "new"], adapter, env)

    expect(moved.code).toBe(0)
    const at = String((calls[0]?.[3] as { at?: string } | undefined)?.at)
    expect(calls).toEqual([["edit", "7", "12", { at }]])
    expect(Date.parse(at) - Date.now()).toBeGreaterThan(118 * 60_000)
    expect(itemOf(moved).scheduled_for).toBe(at)
    expect(nothing.code).not.toBe(0)
    expect(errorOf(nothing).code).toBe("validation_error")
    expect(errorOf(unknown).code).toBe("not_found")
    expect(calls).toHaveLength(1)
  })

  it("**sends now**, answering the scheduled ids and the messages as sent with their new ids", async () => {
    const { adapter, calls } = queue()
    const env = setup()

    const sent = await call(["messages", "scheduled", "send", "Book club", "12", "--json"], adapter, env)

    expect(sent.code).toBe(0)
    const answer = itemOf(sent)
    expect(v.safeParse(ENTITIES.scheduled_send, answer).success).toBe(true)
    expect(answer).toMatchObject({ chat_id: "7", sent: ["12"], messages: [{ id: "40", text: "see you tonight" }] })
    expect(calls).toEqual([["send", "7", ["12"]]])
    expect(new SendJournal(sendsPathFor(app, "default", env)).entries()).toMatchObject([
      { outcome: "sent", kind: "message", key: "messages.scheduled.send", count: 1 },
    ])
  })

  it("**refuses on a messenger without the actions**, and before connecting where it never has them", async () => {
    const { adapter } = queue()
    const { cancelScheduled: _, ...listOnly } = adapter
    let connected = false

    const missing = await call(["messages", "scheduled", "cancel", "Book club", "12"], listOnly, setup())
    const never = await call(
      ["messages", "scheduled", "cancel", "Book club", "12"],
      listOnly,
      setup(),
      {},
      {
        lacks: ["cancelScheduled"],
        connect: async () => {
          connected = true
          return listOnly
        },
      },
    )

    expect(errorOf(missing).message).toContain("this messenger cannot cancel a scheduled message")
    expect(errorOf(never).message).toContain("this messenger cannot cancel a scheduled message")
    expect(connected).toBe(false)
  })
})
