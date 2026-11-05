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

const message = (id: number, chatId = "7"): Message => ({
  id: String(id),
  chatId,
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
  await store.knowledge.relate(null, {
    by: "owner",
    from: "chat:chat/500/7",
    to: project.ref,
    kind: "member-of",
    confirmed: true,
  })
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
  return { call, asked, env, project: project.ref }
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
    expect(body.item.chats[0].next).toBe("nobody")
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
    expect(compact.stdout).toContain("chat:chat/500/7 · next nobody")
    const text = await call("projects", "status", "Harbour", ...WINDOW)
    expect(text.stdout).toContain("HARB · Harbour · 1 linked chats in 1 accounts, 2025-11-30 to 2026-02-01")
    expect(text.stdout).toContain("  1. chat default messages sync 7 --since-time 2025-11-30")
  })

  it("is guarded by the messages permission: it prints what people wrote", () => {
    expect(keyForCommand(["projects", "status"])).toBe("messages")
  })
})

describe("projects evidence purposes and proposed links", () => {
  const withChats = async () => {
    const set = await setUp()
    const store = await openStore({ env: set.env })
    for (const chat of ["8", "11"])
      await store.messages.saveMessages(
        account,
        chat,
        [1, 2, 3].map((id) => message(id, chat)),
        { via: "test" },
      )
    await store.knowledge.relate(null, {
      by: "owner",
      from: "chat:chat/500/8",
      to: set.project,
      kind: "member-of",
      confirmed: true,
      purpose: "sales",
    })
    const proposal = await store.knowledge.proposeRelation(
      null,
      { from: "chat:chat/500/11", to: set.project, kind: "member-of" },
      { bot: "claude-code" },
    )
    await store.close()
    return { ...set, proposal: proposal.id }
  }
  const read = 'chat default messages list 8 "date>=2025-11-30"'

  it("reads the default purpose and leaves a sales chat as one missing row with its count and read command", async () => {
    const { call } = await withChats()
    const { code, stdout } = await call("projects", "evidence", "Harbour", ...WINDOW, "--json")
    expect(code).toBe(0)
    const body = JSON.parse(stdout)
    expect(body.item.purposes).toEqual(["work"])
    expect(body.item.linked_chats.map((one: { ref: string }) => one.ref)).toEqual(["chat:chat/500/7"])
    expect(body.item.left_out).toEqual([
      expect.objectContaining({
        ref: "chat:chat/500/8",
        purpose: "sales",
        messages: 3,
        first_at: "2026-01-01T00:01:00.000Z",
        last_at: "2026-01-01T00:03:00.000Z",
        read_command: read,
      }),
    ])
    expect(body.item.items.some((one: { ref: string }) => one.ref.startsWith("msg:chat/500/8/"))).toBe(false)
    expect(body.missing).toContainEqual({
      field: "linked_chats",
      why: `chat:chat/500/8, purpose sales, not read: 3 messages 2026-01-01…2026-01-01; read it: ${read}`,
      step: "messages.list",
    })
  })

  it("reads every linked chat with --purpose all, and the asked one with --purpose sales", async () => {
    const { call } = await withChats()
    const all = JSON.parse(
      (await call("projects", "evidence", "Harbour", ...WINDOW, "--purpose", "all", "--json")).stdout,
    )
    expect(all.item.purposes).toBe("all")
    expect(all.item.left_out).toEqual([])
    expect(all.item.linked_chats.map((one: { ref: string }) => one.ref)).toEqual(["chat:chat/500/7", "chat:chat/500/8"])
    const sales = JSON.parse(
      (await call("projects", "evidence", "Harbour", ...WINDOW, "--purpose", "sales", "--json")).stdout,
    )
    expect(sales.item.linked_chats.map((one: { ref: string }) => one.ref)).toEqual(["chat:chat/500/8"])
    expect(sales.item.left_out.map((one: { purpose: string }) => one.purpose)).toEqual(["work"])
  })

  it("refuses an unknown purpose and lists the configured ones", async () => {
    const { call } = await withChats()
    const { code, stderr } = await call("projects", "evidence", "Harbour", ...WINDOW, "--purpose", "leads", "--json")
    expect(code).not.toBe(0)
    expect(JSON.parse(stderr).error.message).toBe(
      "unknown purpose leads; the configured ones are work, sales, support, other, or all",
    )
  })

  it("reads a proposed chat only with --include-proposed, and marks every item it alone brought", async () => {
    const { call, proposal } = await withChats()
    const without = JSON.parse((await call("projects", "evidence", "Harbour", ...WINDOW, "--json")).stdout)
    expect(without.item.linked_chats.map((one: { ref: string }) => one.ref)).toEqual(["chat:chat/500/7"])
    expect(without.item.items.some((one: { proposed?: string }) => one.proposed)).toBe(false)

    const found = await call("projects", "evidence", "Harbour", ...WINDOW, "--include-proposed", "--json")
    const body = JSON.parse(found.stdout)
    expect(body.item.linked_chats.at(-1)).toMatchObject({ ref: "chat:chat/500/11", proposed: proposal })
    const fromProposed = body.item.items.filter((one: { ref: string }) => one.ref.startsWith("msg:chat/500/11/"))
    expect(fromProposed).toHaveLength(3)
    expect(fromProposed.every((one: { proposed?: string }) => one.proposed === proposal)).toBe(true)
    expect(
      body.item.items
        .filter((one: { proposed?: string }) => one.proposed)
        .every((one: { ref: string }) => one.ref.startsWith("msg:chat/500/11/")),
    ).toBe(true)

    const text = (await call("projects", "evidence", "Harbour", ...WINDOW, "--include-proposed")).stdout
    expect(text).toContain("[proposed, not confirmed]")
    expect(text).toContain(`read as proposed, not confirmed: chat:chat/500/11 (${proposal})`)
  })

  it("draws items, linked chats and the left-out chat as compact rows", async () => {
    const { call, proposal } = await withChats()
    const { code, stdout } = await call("projects", "evidence", "Harbour", ...WINDOW, "--include-proposed", "--compact")
    expect(code).toBe(0)
    expect(stdout).toContain("# items: 5 · at: 01-01 · context: linked-chat")
    expect(stdout).toContain(`msg:chat/500/11/3 · proposed ${proposal} · crew note 3`)
    expect(stdout).toContain(`#11 · proposed ${proposal} · 3 items`)
    expect(stdout).toContain(`chat:chat/500/8 · sales · 3 messages · 01-01 · 01-01 · ${read}`)
    expect(stdout).toContain("# missing: linked_chats: chat:chat/500/8, purpose sales, not read: 3 messages")
  })

  it("suggests a purpose once when one linked chat with none gives most items, and never changes the link", async () => {
    const { call, env } = await withChats()
    const store = await openStore({ env })
    const many = Array.from({ length: 30 }, (_, index) => message(index + 1))
    await store.messages.saveMessages(account, "7", many, { via: "test" })
    await store.close()
    const body = JSON.parse((await call("projects", "evidence", "Harbour", ...WINDOW, "--json")).stdout)
    expect(body.item.purpose_hint).toMatchObject({ chat: "chat:chat/500/7", items: 30, of: 30 })
    const why = body.missing.find((one: { field: string }) => one.field === "purpose")?.why
    expect(why).toMatch(/^chat:chat\/500\/7 gave 30 of 30 items by membership alone; .* --purpose <purpose>$/)
    const again = await openStore({ env })
    expect((await again.knowledge.relations(null, "chat:chat/500/7"))[0]?.purpose).toBeNull()
    await again.close()
  })
})
