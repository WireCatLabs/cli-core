import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { listEnvelopeSchema } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import type { Chat, Message } from "../../domain/models.js"
import { ENTITIES } from "../../entities/index.js"
import type { MessengerAdapter } from "../../ports/messenger.js"
import { searchStore } from "../../services/messages-archive-search.js"
import { searchNotes } from "../../services/notes-search.js"
import { openStore } from "../../store/store.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import { messagesCommand } from "./messages-command.js"
import { messagesAnswer } from "./search-answers.js"
import { searchCommand } from "./search-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "synthetic", version: "1.0.0" }
const account = { provider: "chat", account: "500" }
const chat: Chat = {
  id: "7",
  title: "Book club",
  kind: "group",
  unreadCount: 0,
  lastMessageAt: "2026-09-27T10:00:00.000Z",
  participantsCount: 4,
}
const message = (id: string, chatId = "7", text = `chapter ${id}`): Message => ({
  id,
  chatId,
  senderId: "9",
  senderName: "Olga",
  timestamp: `2026-09-27T10:0${id}:00.000Z`,
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})
const fake = {
  self: () => "500",
  me: async () => ({ id: "500", name: "Owner", username: null }),
  chats: async () => ({ items: [chat], hasMore: false }),
  history: async () => ({ items: [message("1"), message("2"), message("3")], hasMore: false }),
  resolve: async () => chat,
  close: async () => {},
} as unknown as MessengerAdapter

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), "search-envelope-"))
  const env = { CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "m.db") }
  const runAs = async (tty: boolean, argv: string[]) => {
    const messenger: Messenger = {
      app,
      provider: "chat",
      resolveSettings: settingsFor(app).resolveSettings,
      connect: async () => fake,
      chatArgument: "a chat",
    }
    const streams = captureStreams()
    const code = await run(
      argv,
      { app, commands: () => [messagesCommand(messenger), searchCommand(messenger)] },
      { streams, tty, env },
    )
    return { code, stdout: streams.stdout, stderr: streams.stderr }
  }
  const call = (...argv: string[]) => runAs(false, argv)
  const pretty = (...argv: string[]) => runAs(true, argv)
  await call("messages", "list", "7", "--json")
  const store = await openStore({ path: env.MESSAGING_STORE })
  await store.chats.saveChats(account, [{ ...chat, id: "8", title: "Garden" }])
  await store.messages.saveMessages(account, "8", [message("4", "8")], { via: "history" })
  const accountId = await store.accounts.saveAccount(
    { provider: "email", account: "owner@example.test" },
    { name: null },
  )
  await store.mail.saveThread({
    accountId,
    externalId: "thread-1",
    now: Date.UTC(2026, 0, 2),
    emails: [
      {
        externalId: "<a@example.test>",
        subject: "Reading group",
        from: { address: "alice@example.test", name: "Alice Example" },
        sentAt: Date.UTC(2026, 0, 1),
        bodyText: "Which chapter next?",
      },
    ],
  })
  const tagged = await store.notes.addNote({ title: "Reading list", text: "the chapter to read next" })
  await store.notes.addNote({ title: "Other list", text: "another chapter" })
  await store.knowledge.addTags(account, { type: "note", id: tagged.id }, ["work"])
  await store.searchIndex.fillSearchIndex()
  return { call, pretty, store }
}

const json = (result: { stdout: string[] }) => JSON.parse(result.stdout[0] ?? "null")

describe("search answers", () => {
  it.each([
    [["search", "messages", "chapter"], "message.hit"],
    [["search", "notes", "chapter"], "note.hit"],
    [["search", "all", "chapter"], "hit"],
  ] as const)("%j answers the %s list envelope", async (argv, entity) => {
    const { call, store } = await setup()
    await store.close()
    const answer = json(await call(...argv, "--json"))
    const parsed = v.safeParse(listEnvelopeSchema(ENTITIES[entity] as v.GenericSchema), answer)
    expect(parsed.issues?.map((issue) => `${v.getDotPath(issue)}: ${issue.message}`)).toBeUndefined()
    expect(answer.items.length).toBeGreaterThan(0)
  })

  it("**says discovery searched by words only** while the meaning model is not downloaded", async () => {
    const { call, pretty, store } = await setup()
    await store.close()

    const answer = json(await call("search", "messages", "which chapter?", "--discover", "--json"))
    const parsed = v.safeParse(listEnvelopeSchema(ENTITIES["message.hit"] as v.GenericSchema), answer)
    expect(parsed.issues).toBeUndefined()
    expect(answer.missing).toContainEqual({
      field: "discovery",
      why: "searched by words only: e5-small is not downloaded",
      step: "models.download",
    })
    expect((await pretty("search", "messages", "which chapter?", "--discover")).stderr.join("")).toContain(
      "meaning search not used: e5-small is not downloaded — `chat models download e5-small`, then " +
        "`chat conversations rebuild` gives messages their vectors",
    )
  })

  it("**says discovery kept its own order** while the reranker is not downloaded", async () => {
    const { call, pretty, store } = await setup()
    await store.close()

    const answer = json(await call("search", "messages", "which chapter?", "--discover", "--json"))
    expect(answer.missing).toContainEqual({
      field: "discovery",
      why: "not reranked: mmarco is not downloaded",
      step: "models.download",
    })
    expect((await pretty("search", "messages", "which chapter?", "--discover")).stderr.join("")).toContain(
      "not reranked: mmarco is not downloaded — `chat models download mmarco`",
    )
  })

  it("**says a voice note was found through a garbled spelling**, in the hit and the answer", async () => {
    const { call, store } = await setup()
    await store.messages.saveMessages(
      account,
      "8",
      [{ ...message("5", "8", ""), attachments: [{ kind: "voice", mime: "audio/ogg" }] }],
      { via: "history" },
    )
    const words = Array.from({ length: 60 }, (_, at) => `слово${at}`).join(" ")
    await store.messages.keepTranscript(account, "8", "5", `${words} надо найти реелтора`, "gigaam-v3")
    await store.close()
    const answer = json(await call("search", "messages", "риелтор", "--json"))
    const parsed = v.safeParse(listEnvelopeSchema(ENTITIES["message.hit"] as v.GenericSchema), answer)
    expect(parsed.issues?.map((issue) => `${v.getDotPath(issue)}: ${issue.message}`)).toBeUndefined()
    expect(answer.items).toEqual([
      expect.objectContaining({
        matched_in: "transcript",
        match: "corrected",
        corrections: [{ from: "риелтор", to: ["реелтора"] }],
        excerpt: expect.stringContaining("реелтора"),
      }),
    ])
  })

  it("pages with --page and names the next page with the same query", async () => {
    const { call, pretty, store } = await setup()
    await store.close()
    const first = json(await call("search", "messages", "chapter", "--newest", "--limit", "1", "--json"))
    expect(first.next[0]).toMatchObject({
      step: "page.next",
      command: "search messages",
      args: { query: "chapter", newest: true, page: 2, limit: 1 },
    })
    const second = json(
      await call("search", "messages", "chapter", "--newest", "--limit", "1", "--page", "2", "--json"),
    )
    expect(second.items[0].ref).not.toBe(first.items[0].ref)
    const person = await pretty("search", "messages", "chapter", "--newest", "--limit", "1")
    expect(person.stderr.join("\n")).toContain(
      "→ 1 shown, more exist: chat search messages chapter --newest --page 2 --limit 1",
    )
  })

  it("finds with chat: in the query what --chat found, in the same order", async () => {
    const { store } = await setup()
    try {
      const ids = async (request: { text: string; chat?: string }) =>
        (await searchStore(store, account, { ...request, limit: 10 })).items.map(({ locator }) => locator)
      const flag = await ids({ text: "chapter", chat: "7" })
      expect(flag).toHaveLength(3)
      expect(await ids({ text: "chapter chat:7" })).toEqual(flag)
      const mail = { provider: "email", account: "owner@example.test" }
      const thread = async (request: { text: string; chat?: string }) =>
        (await searchStore(store, mail, { ...request, kind: "mail", limit: 10 })).items.map(({ locator }) => locator)
      const subject = await thread({ text: "chapter", chat: "Reading group" })
      expect(subject).toHaveLength(1)
      expect(await thread({ text: 'chapter chat:"Reading group"' })).toEqual(subject)
    } finally {
      await store.close()
    }
  })

  it("keeps with --filter tag: the notes --tag kept, in the same order", async () => {
    const { store } = await setup()
    try {
      const refs = async (options: { tag?: string; filter?: string }) =>
        (await searchNotes(store, "chapter", { limit: 10, ...options })).hits.map(({ ref }) => ref)
      const tagged = await refs({ tag: "work" })
      expect(tagged).toHaveLength(1)
      expect(await refs({ filter: "tag:work" })).toEqual(tagged)
      expect(await refs({})).toHaveLength(2)
    } finally {
      await store.close()
    }
  })

  it("puts the picture lane after the text hits and names the missing picture model", () => {
    const text = {
      locator: "msg:chat/500/7/1",
      chatId: "7",
      timestamp: "2026-09-27T10:01:00.000Z",
      senderName: "Olga",
      text: "the red cat",
    }
    const found = {
      items: [text],
      hasMore: false,
      pictures: [
        {
          locator: "msg:chat/500/7/1",
          chatId: "7",
          messageId: "1",
          timestamp: text.timestamp,
          senderName: "Olga",
          score: 0.3,
        },
        {
          locator: "msg:chat/500/7/2",
          chatId: "7",
          messageId: "2",
          timestamp: text.timestamp,
          senderName: null,
          score: 0.28,
        },
      ],
      picturesModel: "clip-b32",
      wordsReady: true,
    } as never
    const answer = messagesAnswer("search messages", found, { limit: 10 })
    expect(answer.items.map(({ ref, matched_in }) => [ref, matched_in])).toEqual([
      ["msg:chat/500/7/1", undefined],
      ["msg:chat/500/7/2", "picture"],
    ])
    expect(answer.missing).toEqual([expect.objectContaining({ field: "pictures", step: "models.download-image" })])
  })
})
