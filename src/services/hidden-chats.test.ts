import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import { parseLocator } from "../domain/locator.js"
import type { Message, MessageHit } from "../domain/models.js"
import type { TextModel } from "../embeddings/models.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import type { SendGuard } from "../sends/guard.js"
import { openCache } from "../store/open.js"
import { type MessageStore, openStore } from "../store/store.js"
import { conversationsService } from "./conversations.js"
import { embeddingsService } from "./embeddings.js"
import { servicesFor, storedDeps } from "./index.js"
import { searchAll } from "./search-all.js"

const tiny: TextModel = {
  id: "tiny",
  title: "a five-word model",
  languages: "test",
  licence: "none",
  dims: 4,
  maxTokens: 64,
  chunksPerSecond: 1,
  pooling: "mean",
  prefix: { query: "", passage: "" },
  onnx: "onnx/model.onnx",
  files: [{ name: "onnx/model.onnx", url: "", sha256: "", bytes: 318 }],
}

vi.mock("../embeddings/models.js", async (original) => {
  const real = await original<typeof import("../embeddings/models.js")>()
  return {
    ...real,
    textModel: (id: string) => (id === "tiny" ? tiny : id === "tiny-2" ? { ...tiny, id } : real.textModel(id)),
  }
})

const account = { provider: "test", account: "1" }
const SHOWN = "9"
const HIDDEN = "8"
const SENDER = "100"

const message = (chatId: string, id: string, text: string): Message => ({
  id,
  chatId,
  senderId: SENDER,
  senderName: null,
  timestamp: new Date(Date.parse("2026-10-01T00:00:00Z") + Number(id) * 3_600_000).toISOString(),
  editedAt: null,
  text,
  outgoing: false,
  attachments: [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const opened: MessageStore[] = []
beforeEach(() => {
  const cache = mkdtempSync(join(tmpdir(), "models-"))
  mkdirSync(join(cache, "models", "text"), { recursive: true })
  for (const id of ["tiny", "tiny-2"])
    symlinkSync(
      fileURLToPath(new URL("../embeddings/fixtures/tiny", import.meta.url)),
      join(cache, "models", "text", id),
    )
  vi.stubEnv("WIRECAT_STATE_DIR", cache)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const store of opened.splice(0)) await store.close()
})

/** Chat 8 holds the same words as chat 9, built and embedded alike, and the owner hid it from search. */
const setUp = async (reads: "store" | "server" = "store") => {
  const path = join(mkdtempSync(join(tmpdir(), "hidden-")), "m.db")
  const store = await openStore({ path })
  for (const chatId of [SHOWN, HIDDEN]) {
    await store.chats.saveChats(account, [
      {
        id: chatId,
        title: `chat ${chatId}`,
        kind: "group",
        unreadCount: 0,
        lastMessageAt: null,
        participantsCount: null,
      },
    ])
    await store.messages.saveMessages(
      account,
      chatId,
      [
        message(chatId, "1", "cat dog"),
        message(chatId, "40", "fish"),
        { ...message(chatId, "80", "cat"), mentions: ["200"] },
      ],
      { via: "history" },
    )
  }
  const deps = storedDeps({ provider: "test", app: { command: "chat" } } as Messenger, store, account, {} as SendGuard)
  for (const chatId of [SHOWN, HIDDEN]) {
    await conversationsService(deps).build(chatId)
    await embeddingsService(deps).embed(chatId, { model: "tiny", threads: 1 })
  }
  for (const chatId of [SHOWN, HIDDEN])
    await store.messages.saveMessages(
      account,
      chatId,
      [{ ...message(chatId, "90", ""), attachments: [{ kind: "photo", mime: "image/jpeg" }] }],
      { via: "history" },
    )
  const pictures = await store.vectors.picturesToEmbed(account, { limit: 10 })
  await store.vectors.savePictures(
    account,
    "pic",
    2,
    pictures.map(({ attachmentPk }) => ({
      attachmentPk,
      hash: `pic-${attachmentPk}`,
      bytes: 1,
      occurredAt: 0,
      vector: new Float32Array([1, 0]),
    })),
  )
  await store.close()
  const database = await openCache(path)
  database.prepare("UPDATE chats SET searchable = 0 WHERE external_id = ?").run(HIDDEN)
  database.close()
  const reopened = await openStore({ path })
  opened.push(reopened)
  const hit: MessageHit = { ...message(HIDDEN, "40", "fish"), chatTitle: `chat ${HIDDEN}` }
  const adapter = {
    self: () => account.account,
    searchMessages: async () => ({ items: [hit], hasMore: false, chats: [] }),
  } as unknown as MessengerAdapter
  const messenger = { provider: "test", app: { command: "chat" }, serverSearch: true } as Messenger
  const reopenedDeps = {
    ...storedDeps(messenger, reopened, account, { check: vi.fn(), record: vi.fn() }),
    offline: false,
    reads,
    connection: async () => adapter,
  }
  return { store: reopened, services: servicesFor(reopenedDeps), embeddings: embeddingsService(reopenedDeps) }
}

type Setup = Awaited<ReturnType<typeof setUp>>
type Chats = (setup: Setup) => Promise<string[]>

const chatsOf = (items: { chatId: string }[]) => [...new Set(items.map(({ chatId }) => chatId))].sort()
const conversationChats = (hits: { summary: { chatId: string } }[]) =>
  [...new Set(hits.map(({ summary }) => summary.chatId))].sort()

const UNNAMED: [string, Chats][] = [
  ["store search", async ({ store }) => chatsOf((await store.messages.search("fish", { limit: 10 })).items)],
  [
    "store search, one account",
    async ({ store }) => chatsOf((await store.messages.search("fish", { limit: 10, account })).items),
  ],
  [
    "store find by sender",
    async ({ store }) => chatsOf((await store.messages.find({ account, senders: [SENDER], limit: 10 })).items),
  ],
  [
    "store find by sender, newest per chat",
    async ({ store }) =>
      chatsOf((await store.messages.find({ account, senders: [SENDER], perChat: true, limit: 1 })).items),
  ],
  [
    "store find by sender, everyone together",
    async ({ store }) =>
      chatsOf((await store.messages.find({ account, senders: [SENDER], together: true, limit: 10 })).items),
  ],
  [
    "bound store search",
    async ({ store }) => chatsOf((await store.forAccount(account).messages.search("fish", { limit: 10 })).items),
  ],
  [
    "mentions of a person",
    async ({ store }) => chatsOf((await store.messages.mentioning(account, { id: "200", username: null }, 10)).items),
  ],
  [
    "search messages",
    async ({ services }) => chatsOf((await services.messages.search({ text: "fish", limit: 10 })).items),
  ],
  [
    "search messages from a sender",
    async ({ services }) => chatsOf((await services.messages.search({ text: `from:${SENDER}`, limit: 10 })).items),
  ],
  [
    "search all",
    async ({ store }) =>
      chatsOf(
        (await searchAll(store, account, { text: "fish", limit: 10 })).items.map(({ ref }) => ({
          chatId: parseLocator(ref).chat,
        })),
      ),
  ],
  [
    "conversations search, by meaning and words",
    async ({ embeddings }) => conversationChats((await embeddings.search("fish", { model: "tiny", limit: 10 })).hits),
  ],
  [
    "conversations search, readiness",
    async ({ embeddings }) =>
      (await embeddings.search("fish", { model: "tiny", limit: 10 })).readiness.searchedByMeaning.toSorted(),
  ],
  [
    "conversations search, chats embedded only with another model",
    async ({ embeddings }) =>
      (await embeddings.search("fish", { model: "tiny-2", limit: 10 })).embeddedOnlyElsewhere.toSorted(),
  ],
  [
    "related conversations",
    async ({ embeddings }) =>
      conversationChats((await embeddings.related(SHOWN, "80", { model: "tiny", limit: 10 })).hits),
  ],
  [
    "related conversations, readiness",
    async ({ embeddings }) =>
      (await embeddings.related(SHOWN, "80", { model: "tiny", limit: 10 })).readiness.searchedByMeaning.toSorted(),
  ],
  [
    "pictures nearest a query",
    async ({ store }) =>
      chatsOf(
        await store.vectors.nearestPictures(account, { model: "pic", limit: 10, query: new Float32Array([1, 0]) }),
      ),
  ],
]

describe("a chat the owner hid from search", () => {
  it.each(UNNAMED)("**stays out of %s** that does not name it", async (_, read) => {
    expect(await read(await setUp())).toEqual([SHOWN])
  })

  it("stays out of a server search, though the server found it", async () => {
    const { services } = await setUp("server")
    expect(chatsOf((await services.messages.search({ text: "fish", limit: 10, backend: "server" })).items)).toEqual([])
  })

  const NAMED: [string, Chats][] = [
    [
      "store find by sender in the chat",
      async ({ store }) =>
        chatsOf((await store.messages.find({ account, senders: [SENDER], chatId: HIDDEN, limit: 10 })).items),
    ],
    [
      "search messages --chat",
      async ({ services }) =>
        chatsOf((await services.messages.search({ text: "fish", chat: HIDDEN, limit: 10 })).items),
    ],
    [
      "conversations search --chat",
      async ({ embeddings }) =>
        conversationChats((await embeddings.search("fish", { model: "tiny", chat: HIDDEN, limit: 10 })).hits),
    ],
    [
      "pictures nearest a query in the chat",
      async ({ store }) =>
        chatsOf(
          await store.vectors.nearestPictures(account, {
            chatId: HIDDEN,
            model: "pic",
            limit: 10,
            query: new Float32Array([1, 0]),
          }),
        ),
    ],
  ]

  it.each(NAMED)("is found by %s, which names it", async (_, read) => {
    expect(await read(await setUp())).toEqual([HIDDEN])
  })
})
