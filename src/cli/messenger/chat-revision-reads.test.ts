import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { expect, it } from "vitest"
import type { Chat, Message } from "../../domain/models.js"
import { openStore } from "../../store/store.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import { messagesCommand } from "./messages-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const account = { provider: "chat", account: "500" }
const PHONE = "34000000000@s.whatsapp.net"
const LID = "100000000000000@lid"

const dialog = (id: string): Chat => ({
  id,
  title: "Olga",
  kind: "dialog",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: 2,
})
const message = (id: string, chatId: string, text: string): Message => ({
  id,
  chatId,
  senderId: "500",
  senderName: "Me",
  timestamp: `2026-10-19T10:0${id}:00.000Z`,
  editedAt: null,
  text,
  outgoing: true,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

it("**`messages list` by the id a chat was re-keyed from reads the chat it became**, offline", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-revision-reads-"))
  const env = {
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
  const store = await openStore({ path: env.MESSAGING_STORE })
  await store.chats.saveChats(account, [dialog(PHONE), dialog(LID)])
  await store.messages.saveMessages(account, PHONE, [message("1", PHONE, "typed by number")], { via: "history" })
  await store.messages.saveMessages(account, LID, [message("2", LID, "answered under the LID")], { via: "send" })
  await store.chats.rekeyChat(account, PHONE, LID)
  await store.close()
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => {
      throw new Error("never connects")
    },
    chatArgument: "a chat",
    accountOf: () => account,
    history: "store",
  }
  const streams = captureStreams()

  const code = await run(
    ["messages", "list", PHONE, "--offline", "--json"],
    { app, commands: () => [messagesCommand(messenger)] },
    { streams, tty: false, env },
  )

  expect(streams.stderr.join("\n")).toBe("")
  expect(code).toBe(0)
  const items = JSON.parse(streams.stdout.join("")).items as { chat_id: string; text: string }[]
  expect(items.map(({ chat_id, text }) => [chat_id, text])).toEqual([
    [LID, "typed by number"],
    [LID, "answered under the LID"],
  ])
})
