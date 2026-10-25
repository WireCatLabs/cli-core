import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { Message } from "../domain/models.js"
import * as embeddingRuntime from "../embeddings/embed.js"
import { textModel } from "../embeddings/models.js"
import { registerImageProvider } from "../images/registry.js"
import type { SendGuard } from "../sends/guard.js"
import { openStore } from "../store/store.js"
import { conversationsService } from "./conversations.js"
import { storedDeps } from "./deps.js"
import { embeddingsService } from "./embeddings.js"

const TOPICS = ["lease", "contract"]
const model = textModel("e5-small")

/** A topic detector standing in for the model: a text on a topic gets that topic's axis, any other the last. */
const fakeEmbedder = {
  model,
  embed: async (texts: string[]) =>
    texts.map((text) => {
      const vector = new Float32Array(model.dims)
      const topic = TOPICS.findIndex((word) => text.toLowerCase().includes(word))
      vector[topic === -1 ? model.dims - 1 : topic] = 1
      return vector
    }),
  close: async () => {},
}

const account = { provider: "test", account: "1" }
const START = Date.parse("2026-10-01T10:00:00Z")

const message = (id: string, minute: number, text: string, photo = false): Message => ({
  id,
  chatId: "9",
  senderId: "100",
  senderName: "Anna",
  timestamp: new Date(START + minute * 60_000).toISOString(),
  editedAt: null,
  text,
  outgoing: false,
  attachments: photo ? [{ kind: "photo", name: "scan.jpg", mime: "image/jpeg" }] : [],
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const setUp = async (chats: Record<string, Message[]>) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "image-context-")), "m.db") })
  const deps = {
    ...storedDeps({ provider: "test", app: { command: "chat" } } as Messenger, store, account, {} as SendGuard),
    embedders: {
      get: async () => fakeEmbedder,
      reranker: () => Promise.reject(new Error("no reranker")),
      close: async () => {},
    },
  }
  for (const [id, messages] of Object.entries(chats)) {
    await store.chats.saveChats(account, [
      { id, title: `Chat ${id}`, kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await store.messages.saveMessages(
      account,
      id,
      messages.map((one) => ({ ...one, chatId: id })),
      { via: "history" },
    )
    await conversationsService(deps).build(id)
  }
  const embeddings = embeddingsService(deps)
  for (const id of Object.keys(chats)) await embeddings.embed(id, { model: "e5-small", threads: 1 })
  return { store, embeddings }
}

const imageHits = async (embeddings: ReturnType<typeof embeddingsService>, query: string) =>
  (await embeddings.search(query, { model: "e5-small", limit: 10 })).hits.filter(
    ({ matchedIn }) => matchedIn === "context",
  )

beforeEach(() => {
  vi.spyOn(embeddingRuntime, "isTextModelInstalled").mockReturnValue(true)
})
afterEach(() => vi.restoreAllMocks())

describe("image context", () => {
  it("finds a photo with no caption by what the chat said a minute later, as the photo's own message", async () => {
    const { store, embeddings } = await setUp({
      "9": [message("1", 0, "", true), message("2", 1, "the signed lease is attached"), message("3", 200, "zebra")],
    })
    const hits = await imageHits(embeddings, "lease")
    expect(hits.map(({ chunk, by }) => [chunk.firstMessageId, chunk.lastMessageId, by])).toEqual([
      ["1", "1", ["meaning"]],
    ])
    await store.close()
  })

  it("does not give a photo the text of another chat, however close in time", async () => {
    const { store, embeddings } = await setUp({
      "9": [message("1", 0, "", true)],
      "10": [{ ...message("5", 1, "the signed lease is attached"), chatId: "10" }],
    })
    expect(await imageHits(embeddings, "lease")).toEqual([])
    await store.close()
  })

  it("ignores messages more than ten minutes away", async () => {
    const { store, embeddings } = await setUp({
      "9": [message("1", 0, "", true), message("2", 11, "the signed lease is attached")],
    })
    expect(await imageHits(embeddings, "lease")).toEqual([])
    await store.close()
  })

  it("describes the image again when a provider's version changes", async () => {
    const { store, embeddings } = await setUp({ "9": [message("1", 0, "", true), message("2", 1, "a lease")] })
    const undo = registerImageProvider({
      id: "context",
      version: "2",
      describe: async () => ({ text: "a signed contract" }),
    })
    try {
      await embeddings.embed("9", { model: "e5-small", threads: 1 })
      expect((await imageHits(embeddings, "contract")).map(({ chunk }) => chunk.firstMessageId)).toEqual(["1"])
      expect(await imageHits(embeddings, "lease")).toEqual([])
    } finally {
      undo()
      await store.close()
    }
  })
})
