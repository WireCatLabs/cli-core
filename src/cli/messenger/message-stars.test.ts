import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import type { Chat, Message } from "../../domain/models.js"
import { openStore } from "../../store/store.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import { messagesCommand } from "./messages-command.js"
import { searchCommand } from "./search-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const account = { provider: "chat", account: "500" }
const chat = (id: string, title: string): Chat => ({
  id,
  title,
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: 3,
})
const message = (id: string, chatId: string, text: string, minute: number): Message => ({
  id,
  chatId,
  senderId: "9",
  senderName: "Olga",
  timestamp: `2026-10-18T10:${String(minute).padStart(2, "0")}:00.000Z`,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const sandbox = async () => {
  const root = mkdtempSync(join(tmpdir(), "message-stars-"))
  const env = {
    CHAT_PROFILE: "default",
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
  const store = await openStore({ path: env.MESSAGING_STORE })
  await store.chats.saveChats(account, [chat("7", "Book club"), chat("8", "Garden")])
  await store.messages.saveMessages(
    account,
    "7",
    [message("1", "7", "the venue changed", 1), message("2", "7", "see you there", 2)],
    { via: "history", stars: [{ messageId: "1", starred: true }] },
  )
  await store.messages.saveMessages(account, "8", [{ ...message("3", "8", "seeds for spring", 3), starred: true }], {
    via: "history",
  })
  await store.close()
  return env
}

const call = async (argv: string[], env: NodeJS.ProcessEnv, own: Partial<Messenger>) => {
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => {
      throw new Error("never connects")
    },
    chatArgument: "a chat",
    accountOf: () => account,
    ...own,
  }
  const streams = captureStreams()
  const code = await run(
    argv,
    { app, commands: () => [messagesCommand(messenger), searchCommand(messenger)] },
    { streams, tty: false, env },
  )
  return { code, stdout: streams.stdout.join(""), stderr: streams.stderr.join("\n") }
}

const STARS: Partial<Messenger> = { history: "store", messageStars: true }

describe("starred messages", () => {
  it("**`messages list starred:true` keeps the ones the owner starred**, from the store, each marked", async () => {
    const env = await sandbox()

    const { code, stdout, stderr } = await call(["messages", "list", "7", "starred:true", "--json"], env, STARS)

    expect(stderr).toBe("")
    expect(code).toBe(0)
    expect(JSON.parse(stdout).items.map(({ id, starred }: { id: string; starred?: true }) => [id, starred])).toEqual([
      ["1", true],
    ])
  })

  it("`starred:false` keeps the others, and a plain list marks only the starred one", async () => {
    const env = await sandbox()

    const others = await call(["messages", "list", "7", "starred:false", "--json"], env, STARS)
    const all = await call(["messages", "list", "7", "--json"], env, STARS)

    expect(JSON.parse(others.stdout).items.map(({ id }: { id: string }) => id)).toEqual(["2"])
    expect(JSON.parse(all.stdout).items.map(({ starred }: { starred?: true }) => starred ?? null)).toEqual([true, null])
  })

  it("`search messages is:starred` finds them across chats", async () => {
    const env = await sandbox()

    const { code, stdout } = await call(["search", "messages", "is:starred", "--json"], env, STARS)

    expect(code).toBe(0)
    expect(JSON.parse(stdout).items.map(({ ref }: { ref: string }) => ref.split("/").at(-1))).toEqual(["3", "1"])
  })

  it("is no field of a messenger without stars", async () => {
    const env = await sandbox()

    const { code, stderr } = await call(["messages", "list", "7", "starred:true", "--json"], env, { history: "store" })

    expect(code).toBe(2)
    expect(stderr).toContain("starred")
  })

  it("refuses while the list reads from the messenger, which filters nothing", async () => {
    const env = await sandbox()

    const { code, stderr } = await call(["messages", "list", "7", "starred:true", "--json"], env, {
      messageStars: true,
    })

    expect(code).toBe(2)
    expect(stderr).toContain("starred: reads the local store")
  })
})
