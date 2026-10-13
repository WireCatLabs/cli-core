import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import type { Chat, Message } from "../../domain/models.js"
import { openStore } from "../../store/store.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import { chatsCommand } from "./chats-command.js"
import type { Messenger } from "./context.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "", version: "1.0.0" }
const OWNER = { provider: "chat", account: "500" }
const PLAN = "1PlanSyntheticFileId_000"
const SHEET = "2SheetSyntheticFileId_00"
const GONE = "3GoneSyntheticFileId_000"
const doc = (id: string) => `https://docs.google.com/document/d/${id}/edit`

const chat = (id: string): Chat => ({
  id,
  title: `Fixture ${id}`,
  kind: "group",
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount: null,
})
const message = (id: string, minute: number, text: string): Message => ({
  id,
  chatId: "7",
  senderId: "10",
  senderName: "Alice Synthetic",
  timestamp: new Date(Date.UTC(2026, 0, 1, 10, minute)).toISOString(),
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const setup = async (config?: object) => {
  const root = mkdtempSync(join(tmpdir(), "chat-documents-"))
  const env = {
    ...process.env,
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_CONFIG_DIR: join(root, "config"),
    MESSAGING_STORE: join(root, "m.db"),
  }
  if (config) {
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify(config))
  }
  rememberAccount(app, "default", "500", env)
  const store = await openStore({ path: env.MESSAGING_STORE })
  await store.saveChats(OWNER, [chat("7"), chat("8")])
  await store.saveMessages(
    OWNER,
    "7",
    [
      message("1", 1, `plan: ${doc(PLAN)}`),
      message("2", 2, `both ${doc(SHEET)} and ${doc(PLAN)}.`),
      message("3", 3, `the id alone ${PLAN} and a page https://drive.google.com/drive/my-drive`),
      message("4", 4, `old copy ${doc(GONE)}`),
      message("5", 5, "nothing here"),
    ],
    { via: "history" },
  )
  const folder = await store.notes.addFolder({ name: "Drive" })
  const save = (fileId: string, title: string) =>
    store.notes.saveFileNote({ folderId: folder.id, path: `${fileId}.md`, title, text: "", frontMatter: { fileId } })
  const plan = (await save(PLAN, "Q4 plan")).note
  const gone = (await save(GONE, "Old copy")).note
  const linked = await store.notes.linkMessages({
    documents: [
      { reference: plan.ref, fileId: PLAN },
      { reference: gone.ref, fileId: GONE },
    ],
  })
  await store.notes.deleteFileNotes(folder.id, [`${GONE}.md`])
  await store.close()
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => {
      throw new Error("never connects")
    },
    chatArgument: "a chat",
  }
  const runs =
    (tty: boolean) =>
    async (...argv: string[]) => {
      const streams = captureStreams()
      const code = await run(
        argv,
        { app, commands: () => [chatsCommand(messenger)] },
        { streams, tty, env: { ...env, NO_COLOR: "1" } },
      )
      return { code, stdout: streams.stdout.join(""), stderr: streams.stderr.join("\n") }
    }
  return { call: runs(false), pretty: runs(true), env, linked, plan }
}

const json = (result: { stdout: string }) => JSON.parse(result.stdout || "null")

describe("chats documents list", () => {
  it("**lists every Google link in the chat, newest first, and which document the store holds**", async () => {
    const { call, linked } = await setup()
    expect(linked).toBe(3)
    const sender = { id: "10", name: "Alice Synthetic" }
    const listed = await call("chats", "documents", "list", "7", "--json")
    expect(listed.stderr).toBe("")
    expect(json(listed)).toEqual({
      items: [
        {
          url: doc(GONE),
          documentId: GONE,
          title: null,
          inStore: false,
          locator: "msg:chat/500/7/4",
          sentAt: "2026-01-01T10:04:00.000Z",
          sender,
        },
        {
          url: "https://drive.google.com/drive/my-drive",
          documentId: null,
          title: null,
          inStore: false,
          locator: "msg:chat/500/7/3",
          sentAt: "2026-01-01T10:03:00.000Z",
          sender,
        },
        {
          url: doc(SHEET),
          documentId: SHEET,
          title: null,
          inStore: false,
          locator: "msg:chat/500/7/2",
          sentAt: "2026-01-01T10:02:00.000Z",
          sender,
        },
        {
          url: doc(PLAN),
          documentId: PLAN,
          title: "Q4 plan",
          inStore: true,
          locator: "msg:chat/500/7/2",
          sentAt: "2026-01-01T10:02:00.000Z",
          sender,
        },
        {
          url: doc(PLAN),
          documentId: PLAN,
          title: "Q4 plan",
          inStore: true,
          locator: "msg:chat/500/7/1",
          sentAt: "2026-01-01T10:01:00.000Z",
          sender,
        },
      ],
      page: 1,
      limit: 20,
      hasMore: false,
    })
  })

  it("pages by link, not by message", async () => {
    const { call } = await setup()
    const first = json(await call("chats", "documents", "list", "7", "--limit", "2", "--json"))
    expect(first).toMatchObject({ page: 1, limit: 2, hasMore: true })
    const third = json(await call("chats", "documents", "list", "7", "--limit", "2", "--page", "3", "--json"))
    expect(third).toMatchObject({ page: 3, limit: 2, hasMore: false })
    expect(third.items.map(({ locator }: { locator: string }) => locator)).toEqual(["msg:chat/500/7/1"])
    expect((await call("chats", "documents", "list", "7", "--all")).code).not.toBe(0)
  })

  it("answers an empty list with a hint on stderr for a chat with no stored messages", async () => {
    const { call } = await setup()
    const empty = await call("chats", "documents", "list", "8", "--json")
    expect(json(empty)).toEqual({ items: [], page: 1, limit: 20, hasMore: false })
    expect(empty.stderr).toContain("chat store fetch 8")
  })

  it("prints one line per link for a person", async () => {
    const { pretty } = await setup()
    const lines = (await pretty("chats", "documents", "list", "7", "--limit", "1", "--page", "5")).stdout
    expect(lines).toBe(`2026-01-01T10:01:00.000Z  Alice Synthetic  Q4 plan  in store\n`)
  })

  it("is refused by deny messages and runs on a read-only profile", async () => {
    const denied = await setup({ profiles: { default: { permissions: { messages: "deny" } } } })
    expect((await denied.call("chats", "documents", "list", "7", "--json")).code).toBe(5)
    const readOnly = await setup({ profiles: { default: { permissions: { messages: "readonly" } } } })
    expect((await readOnly.call("chats", "documents", "list", "7", "--json")).code).toBe(0)
  })
})

describe("notes.linkMessages", () => {
  it("adds nothing on a rerun, skips older messages with since, and refuses a non-document", async () => {
    const { env, plan } = await setup()
    const store = await openStore({ path: env.MESSAGING_STORE })
    try {
      expect(await store.notes.linkMessages({ documents: [{ reference: plan.ref, fileId: PLAN }] })).toBe(0)
      await store.saveMessages(OWNER, "7", [message("6", 6, `again ${doc(PLAN)}`)], { via: "history" })
      const future = new Date(Date.now() + 60_000).toISOString()
      expect(
        await store.notes.linkMessages({ documents: [{ reference: plan.ref, fileId: PLAN }], since: future }),
      ).toBe(0)
      expect(await store.notes.linkMessages({ documents: [{ reference: plan.ref, fileId: PLAN }] })).toBe(1)
      const links = await store.notes.links({ to: plan.ref })
      expect(links.map(({ from, origin }) => [from, origin])).toEqual([
        ["msg:chat/500/7/1", "message"],
        ["msg:chat/500/7/2", "message"],
        ["msg:chat/500/7/6", "message"],
      ])
      await expect(
        store.notes.linkMessages({ documents: [{ reference: "msg:chat/500/7/1", fileId: PLAN }] }),
      ).rejects.toThrow("not a document")
      await expect(
        store.notes.linkMessages({ documents: [{ reference: plan.ref, fileId: PLAN }], since: "soon" }),
      ).rejects.toThrow("ISO 8601")
    } finally {
      await store.close()
    }
  })
})
