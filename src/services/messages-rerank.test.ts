import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { Message } from "../domain/models.js"
import type { RerankModel } from "../embeddings/models.js"
import type { SendGuard } from "../sends/guard.js"
import { type MessageStore, openStore } from "../store/store.js"
import { storedDeps } from "./deps.js"
import { searchStore } from "./messages-archive-search.js"
import { pairInput, type RerankLane } from "./messages-discovery.js"
import { rerankLane } from "./messages-rerank.js"

const tiny: RerankModel = {
  id: "mmarco",
  title: "the tiny cross-encoder under the default reranker's name",
  languages: "test",
  licence: "none",
  maxTokens: 64,
  onnx: "onnx/model.onnx",
  files: [{ name: "onnx/model.onnx", url: "", sha256: "", bytes: 267 }],
}

vi.mock("../embeddings/models.js", async (original) => {
  const real = await original<typeof import("../embeddings/models.js")>()
  return { ...real, rerankModel: (id: string) => (id === "mmarco" ? tiny : real.rerankModel(id)) }
})

const account = { provider: "test", account: "1" }
const stores: MessageStore[] = []

const message = (id: string, text: string): Message => ({
  id,
  chatId: "9",
  senderId: "100",
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

let models = ""
const download = () => {
  mkdirSync(join(models, "models", "text"), { recursive: true })
  symlinkSync(
    fileURLToPath(new URL("../embeddings/fixtures/tiny-rerank", import.meta.url)),
    join(models, "models", "text", "mmarco"),
  )
}

const setUp = async (reranker?: string, replies: Record<string, string> = {}) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "discover-rerank-")), "m.db") })
  stores.push(store)
  await store.chats.saveChats(account, [
    { id: "9", title: "Chat 9", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  // The tiny reranker likes kitten: it puts 2 first and 1 second, words put 1 first and 3 second.
  await store.messages.saveMessages(
    account,
    "9",
    [
      message("1", "cat dog kitten kitten kitten"),
      message("2", "dog kitten kitten kitten kitten kitten"),
      message("3", "dog"),
      message("4", "kitten"),
    ].map((one) => (replies[one.id] ? { ...one, replyToId: replies[one.id] } : one)),
    { via: "history" },
  )
  await store.searchIndex.fillSearchIndex({})
  await store.searchIndex.fillStems({})
  const deps = storedDeps({ provider: "test", app: { command: "chat" } } as Messenger, store, account, {} as SendGuard)
  const discover = (text: string, extra: object = {}, lane = rerankLane({ ...deps, reranker })) =>
    searchStore(store, account, { text, discover: true, limit: 10, timezone: "UTC", ...extra }, {}, undefined, lane)
  return { discover }
}

beforeEach(() => {
  models = mkdtempSync(join(tmpdir(), "models-"))
  vi.stubEnv("WIRECAT_STATE_DIR", models)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) await store.close()
})

describe("discovery's reranker", () => {
  it("keeps discovery's order and says why while the model is not downloaded", async () => {
    const { discover } = await setUp()

    const found = await discover("cat dog")

    expect(found.items.map(({ id }) => id)).toEqual(["1", "3", "2"])
    expect(found.rerankSkipped).toEqual({
      reason: "mmarco is not downloaded",
      step: "models.download",
      model: "mmarco",
    })
    expect(found.query?.discovery?.rerank).toBeUndefined()
  })

  it("**mixes its score with discovery's**, 0.7 to 0.3, and shows its own score on each hit it read", async () => {
    download()
    const { discover } = await setUp()

    const found = await discover("cat dog")

    expect(found.rerankSkipped).toBeUndefined()
    expect(found.query?.discovery?.rerank).toEqual({ model: "mmarco", scored: 3 })
    // Replacing the order would put 2 first; mixed, 1 keeps the first place its words earned.
    expect(found.items.map(({ id, discovery }) => [id, discovery?.rerankerScore])).toEqual([
      ["1", 5],
      ["2", 6],
      ["3", 1],
    ])
  })

  it("reads the message a reply answers before it, also when the messenger kept only its id", async () => {
    download()
    const { discover } = await setUp(undefined, { "3": "4" })

    const found = await discover("cat dog")

    // The question's cat, and the parent's kitten.
    expect(found.items.find(({ id }) => id === "3")?.discovery?.rerankerScore).toBe(2)
  })

  it("reads only the start of a long parent, so the reply itself always fits", () => {
    const reply = { ...message("3", "the answer"), chatTitle: "Chat 9" } as Parameters<typeof pairInput>[0]
    const parent = message("2", "context ".repeat(400))

    const [before, after] = pairInput(reply, parent).split("\n")

    expect(before).toHaveLength(300)
    expect(before).toMatch(/^\[Chat 9 · unknown · 2026-10-01\] context/)
    expect(after).toBe("[Chat 9 · unknown · 2026-10-01] the answer")
  })

  it("is not used when the profile turned it off, and says nothing", async () => {
    download()
    const { discover } = await setUp("off")

    const found = await discover("cat dog")

    expect(found.items.map(({ id }) => id)).toEqual(["1", "3", "2"])
    expect(found.rerankSkipped).toBeUndefined()
  })

  it("leaves strict search alone", async () => {
    download()
    const { discover } = await setUp()

    const found = await discover("dog", { exact: true })

    expect(found.rerankSkipped).toBeUndefined()
    expect(found.items.every(({ discovery }) => discovery?.rerankerScore === undefined)).toBe(true)
  })

  it("**gives up the reranking, not the search,** when scoring would pass its own time limit", async () => {
    const { discover } = await setUp()
    let now = 0
    vi.spyOn(performance, "now").mockImplementation(() => now)
    const slow: RerankLane = async () => ({
      model: "slow",
      score: async (_question, passages) => {
        now += 16_000
        return passages.map(() => 1)
      },
      done: async () => {},
    })

    const found = await discover("cat dog", {}, slow)

    expect(found.items.map(({ id }) => id)).toEqual(["1", "3", "2"])
    expect(found.rerankSkipped).toEqual({ reason: "scoring would take longer than it may", model: "slow" })
  })
})
