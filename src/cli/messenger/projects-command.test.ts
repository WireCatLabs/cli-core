import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { describe, expect, it } from "vitest"
import type { Message } from "../../domain/models.js"
import type { MessengerAdapter, ServerReads } from "../../ports/messenger.js"
import { keyForCommand } from "../../sends/permissions.js"
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

/** Only so the steps `projects status` names exist in this program. */
const messagesStub = () => {
  const messages = new Command("messages")
  messages
    .command("sync")
    .argument("[chat]")
    .option("--since-time <time>")
    .action(() => {})
  messages
    .command("list")
    .argument("<chat>")
    .argument("[query...]")
    .action(() => {})
  return messages
}

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
    const code = await run(
      argv,
      { app, commands: () => [projectsCommand(messenger), messagesStub()] },
      { streams, tty, env },
    )
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
    "chat:chat/500/7: never fetched — sync it: chat default projects evidence Harbour --since-time 2025-11-30 --sync-first",
  )
})

it("names in --json the command that syncs a linked chat it does not hold, and exits 0 on that partial answer", async () => {
  const { call } = await setUp()
  const { code, stdout } = await call("projects", "evidence", "Harbour", ...WINDOW, "--json")
  expect(code).toBe(0)
  const body = JSON.parse(stdout)
  expect(body.meta.complete).toBe(false)
  expect(body.item.linked_chats[0]).toMatchObject({
    chat: "7",
    sync_command: "chat default projects evidence Harbour --since-time 2025-11-30 --sync-first",
  })
})

it("with --sync-first syncs the linked chat back to the window first, then reads it as held", async () => {
  const { call, asked } = await setUp()
  const { code, stdout, stderr } = await call("projects", "evidence", "Harbour", ...WINDOW, "--sync-first", "--json")
  expect(code).toBe(0)
  expect(asked.length).toBeGreaterThan(0)
  const body = JSON.parse(stdout)
  expect(body.item.fetch).toEqual([
    { chat: "chat:chat/500/7", state: "complete", reason: null, elapsed_ms: expect.any(Number) },
  ])
  expect(body.item.linked_chats[0]).toMatchObject({
    chat: "7",
    completeness: { state: "complete" },
    sync_command: null,
  })
  expect(body.item.items.length).toBe(10)
  expect(body.missing).toBeUndefined()
  expect(stderr).toMatch(/chat 1 of 1 · chat:chat\/500\/7 · \d+ messages so far/)
})

it("is guarded by the messages permission: it prints what people wrote", () => {
  expect(keyForCommand(["projects", "evidence"])).toBe("messages")
})

describe("projects status", () => {
  it("answers from the store alone, for this profile's account, and syncs the chat it holds in part first", async () => {
    const { call, asked } = await setUp()
    const { code, stdout } = await call(
      "projects",
      "status",
      "Harbour",
      ...WINDOW,
      "--context-query",
      "crew note",
      "--json",
    )
    expect(code).toBe(0)
    expect(asked).toEqual([])
    const body = JSON.parse(stdout)
    expect(body.item).toMatchObject({ project: expect.stringMatching(/^project:\d+$/), name: "Harbour" })
    expect(body.item.chats).toEqual([expect.objectContaining({ chat: "chat:chat/500/7", coverage: "unknown" })])
    expect(body.item.reply_next[0].data.next).toBe("nobody")
    expect(body.item.topics[0].data).toMatchObject({ query: "crew note", theirs_last: "2026-01-01T00:10:00.000Z" })
    expect(body.meta).toMatchObject({ complete: false, accounts: ["chat/500"] })
    expect(body.next[0]).toMatchObject({
      command: "messages sync",
      line: "chat messages sync 7 --since-time 2025-11-30",
    })
  })

  it("prints one line per item with --compact, and a human summary on a terminal", async () => {
    const { call } = await setUp()
    const compact = await call("projects", "status", "Harbour", ...WINDOW, "--compact")
    expect(compact.code).toBe(0)
    expect(compact.stdout).toContain("msg:chat/500/7/10 · chat:chat/500/7 · nobody · 01-01")
    const text = await call("projects", "status", "Harbour", ...WINDOW)
    expect(text.stdout).toContain("HARB · Harbour · 1 linked chats in 1 accounts, 2025-11-30 to 2026-02-01")
    expect(text.stdout).toContain("  1. chat default messages sync 7 --since-time 2025-11-30")
  })

  it("is guarded by the messages permission: it prints what people wrote", () => {
    expect(keyForCommand(["projects", "status"])).toBe("messages")
  })
})
