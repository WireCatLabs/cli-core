import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { expect, it } from "vitest"
import type { Message } from "../../domain/models.js"
import type { MessengerAdapter, ServerReads } from "../../ports/messenger.js"
import { openStore } from "../../store/store.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import { projectsCommand } from "./projects-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }
const account = { provider: "chat", account: "500" }

const message = (id: number): Message => ({
  id: String(id),
  chatId: "7",
  senderId: "9",
  senderName: "Olga",
  timestamp: new Date(Date.UTC(2026, 0, 1) + id * 60_000).toISOString(),
  editedAt: null,
  text: `crew note ${id}`,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const chatOf = (asked: (string | undefined)[]): MessengerAdapter & ServerReads =>
  ({
    self: () => "500",
    close: async () => {},
    history: async (_chat: string, { limit, before }: { limit: number; before?: string }) => {
      asked.push(before)
      const upper = before === undefined ? 10 : Number(before) - 1
      const low = Math.max(1, upper - limit + 1)
      const items = upper < 1 ? [] : Array.from({ length: upper - low + 1 }, (_, index) => message(low + index))
      return { items, hasMore: low > 1 }
    },
  }) as unknown as MessengerAdapter & ServerReads

const setUp = async () => {
  const root = mkdtempSync(join(tmpdir(), "projects-"))
  const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
  mkdirSync(join(env.CHAT_STATE_DIR, "accounts"), { recursive: true })
  writeFileSync(join(env.CHAT_STATE_DIR, "accounts", "default.json"), JSON.stringify({ account: "500" }))
  const store = await openStore({ env })
  await store.messages.saveMessages(account, "7", [message(9), message(10)], { via: "test" })
  const project = await store.knowledge.addProject({ name: "Harbour" })
  await store.knowledge.relate(null, { from: "chat:chat/500/7", to: project.ref, kind: "member-of", confirmed: true })
  await store.close()
  const asked: (string | undefined)[] = []
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => chatOf(asked),
    chatArgument: "a chat",
  }
  const call = async (...argv: string[]) => {
    const streams = captureStreams()
    const tty = !argv.includes("--json")
    const code = await run(argv, { app, commands: () => [projectsCommand(messenger)] }, { streams, tty, env })
    return { code, stdout: streams.stdout.join(""), stderr: streams.stderr.join("") }
  }
  return { call, asked }
}

const WINDOW = ["--since-time", "2025-12-01", "--before-time", "2026-02-01T00:00:00Z"]

it("reads only the store and names the fetch for a linked chat it does not hold", async () => {
  const { call, asked } = await setUp()
  const { code, stdout } = await call("projects", "evidence", "Harbour", ...WINDOW)
  expect(code).toBe(0)
  expect(asked).toEqual([])
  expect(stdout).toContain(
    "chat:chat/500/7: never fetched — sync it: chat default projects evidence Harbour --since-time 2025-11-30 --fetch",
  )
})

it("with --fetch syncs the linked chat back to the window first, then reads it as held", async () => {
  const { call, asked } = await setUp()
  const { code, stdout, stderr } = await call("projects", "evidence", "Harbour", ...WINDOW, "--fetch", "--json")
  expect(code).toBe(0)
  expect(asked.length).toBeGreaterThan(0)
  const body = JSON.parse(stdout)
  expect(body.item.fetch).toEqual([
    { chat: "chat:chat/500/7", state: "complete", reason: null, elapsed_ms: expect.any(Number) },
  ])
  expect(body.item.linked_chats[0]).toMatchObject({ chat: "7", completeness: { state: "complete" } })
  expect(body.item.items.length).toBe(10)
  expect(body.missing).toBeUndefined()
  expect(stderr).toMatch(/chat 1 of 1 · chat:chat\/500\/7 · \d+ messages so far/)
})
