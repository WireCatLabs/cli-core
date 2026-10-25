import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import { chunkHash } from "../conversations/chunks.js"
import type { Message } from "../domain/models.js"
import { useProviders } from "../domain/providers.js"
import * as embeddingRuntime from "../embeddings/embed.js"
import type { TextModel } from "../embeddings/models.js"
import { textModel } from "../embeddings/models.js"
import type { SendGuard } from "../sends/guard.js"
import { openCache } from "../store/open.js"
import { openStore, registerProvider } from "../store/store.js"
import { conversationsService } from "./conversations.js"
import { storedDeps } from "./deps.js"
import { embeddingsService } from "./embeddings.js"
import { prepareLucene } from "./messages-search.js"

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

const message = (id: string, text: string, replyToId?: string): Message => ({
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
  ...(replyToId ? { replyToId } : {}),
  forwardedFrom: null,
  reactions: null,
})

const setUp = async ({
  build = true,
  messages = [message("1", "cat dog"), message("2", "dog", "1"), message("40", "fish"), message("80", "cat")],
} = {}) => {
  const path = join(mkdtempSync(join(tmpdir(), "embed-")), "m.db")
  const store = await openStore({ path })
  await store.chats.saveChats(account, [
    { id: "9", title: "Group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.messages.saveMessages(account, "9", messages, { via: "history" })
  const deps = storedDeps({ provider: "test", app: { command: "chat" } } as Messenger, store, account, {} as SendGuard)
  const conversations = conversationsService(deps)
  if (build) await conversations.build("9")
  return { store, embeddings: embeddingsService(deps), conversations, path }
}

beforeEach(() => {
  const cache = mkdtempSync(join(tmpdir(), "models-"))
  mkdirSync(join(cache, "models", "text"), { recursive: true })
  for (const id of ["tiny", "tiny-2"]) {
    symlinkSync(
      fileURLToPath(new URL("../embeddings/fixtures/tiny", import.meta.url)),
      join(cache, "models", "text", id),
    )
  }
  vi.stubEnv("WIRECAT_STATE_DIR", cache)
})
afterEach(() => {
  vi.unstubAllEnvs()
  useProviders([])
})

describe("embeddings", () => {
  it("**embeds every chunk of the current build once**, and a second run embeds nothing", async () => {
    const { store, embeddings } = await setUp()
    expect(await embeddings.status("9", "tiny")).toMatchObject({ chunks: 3, embedded: 0, left: 3 })

    const seen: number[] = []
    const done = await embeddings.embed("9", { model: "tiny", threads: 1, progress: (embedded) => seen.push(embedded) })

    expect(done).toEqual({ chat: "9", model: "tiny", embedded: 3, skipped: 0 })
    expect(seen.at(-1)).toBe(3)
    expect(await embeddings.status("9", "tiny")).toMatchObject({ chunks: 3, embedded: 3, left: 0 })
    expect((await embeddings.embed("9", { model: "tiny", threads: 1 })).embedded).toBe(0)

    expect(await embeddings.clear("9", "tiny")).toEqual({ chat: "9", cleared: 3 })
    expect(await embeddings.status("9", "tiny")).toMatchObject({ embedded: 0, left: 3 })
    await store.close()
  })

  it("**finds the conversation nearest in meaning**, best first, with the chunk that matched", async () => {
    const { store, embeddings } = await setUp()
    await embeddings.embed("9", { model: "tiny", threads: 1 })

    const { hits } = await embeddings.search("fish", { model: "tiny", limit: 3 })

    expect(hits).toHaveLength(1)
    expect([hits[0]?.summary.firstMessageId, hits[0]?.chunk]).toEqual([
      "40",
      { firstMessageId: "40", lastMessageId: "40" },
    ])
    expect(hits[0]?.score).toBeCloseTo(1)
    expect(
      (await embeddings.search("fish", { model: "tiny", chat: "9", limit: 5, since: "2026-10-03T00:00:00Z" })).hits.map(
        ({ summary }) => summary.firstMessageId,
      ),
    ).toEqual([])
    await store.close()
  })

  it("names a chat embedded only with another model, which the search finds by words alone", async () => {
    const { store, embeddings } = await setUp()
    await embeddings.embed("9", { model: "tiny", threads: 1 })

    expect(await embeddings.search("fish", { model: "tiny-2", limit: 3 })).toMatchObject({
      hits: [{ summary: { firstMessageId: "40" }, score: null, by: ["words"] }],
      embeddedOnlyElsewhere: ["9"],
    })
    expect((await embeddings.search("fish", { model: "tiny", limit: 3 })).embeddedOnlyElsewhere).toEqual([])
    await store.close()
  })

  it("**merges meaning and words**: a word only one message holds, and a meaning no message spells, each land first", async () => {
    const { store, embeddings } = await setUp({
      messages: [message("1", "cat cat"), message("40", "dog zebra"), message("80", "dog"), message("120", "fish")],
    })
    await embeddings.embed("9", { model: "tiny", threads: 1 })

    const [byMeaning] = (await embeddings.search("kitten", { model: "tiny", limit: 4 })).hits
    expect(byMeaning).toMatchObject({ summary: { firstMessageId: "1" }, by: ["meaning"] })
    expect(byMeaning?.score).toBeCloseTo(1)

    const [byWords] = (await embeddings.search("zebra", { model: "tiny", limit: 4 })).hits
    expect(byWords).toMatchObject({
      summary: { firstMessageId: "40" },
      chunk: { firstMessageId: "40", lastMessageId: "40" },
      by: ["words"],
    })
    await store.close()
  })

  it("leaves out what the word search finds only by correcting the query, keeps a word's longer forms", async () => {
    const { store, embeddings } = await setUp({ messages: [message("1", "kitchen")] })
    expect((await embeddings.search("kitten", { model: "tiny", limit: 4 })).hits).toEqual([])

    await store.messages.saveMessages(account, "9", [message("40", "kittens")], { via: "history" })
    await conversationsService(
      storedDeps({ provider: "test", app: { command: "chat" } } as Messenger, store, account, {} as SendGuard),
    ).build("9")
    expect((await embeddings.search("kitten", { model: "tiny", limit: 4 })).hits).toMatchObject([
      { summary: { firstMessageId: "40" }, by: ["words"] },
    ])
    await store.close()
  })

  it("refuses a chat with no conversations, and a model that is not downloaded, naming what to run", async () => {
    const { store, embeddings } = await setUp({ build: false })
    await expect(embeddings.embed("9", { model: "tiny" })).rejects.toThrow("chat conversations links rebuild --chat 9")
    await conversationsService(
      storedDeps({ provider: "test", app: { command: "chat" } } as Messenger, store, account, {} as SendGuard),
    ).build("9")
    await expect(embeddings.embed("9", { model: "e5-small" })).rejects.toThrow("chat models download e5-small")
    await store.close()
  })
})

describe("strict conversation search scope", () => {
  it("filters before ranking and allows a matching author anywhere in the conversation", async () => {
    const { store, embeddings } = await setUp({
      messages: [message("1", "fish"), { ...message("2", "dog", "1"), senderId: "200" }, message("40", "fish")],
    })
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    const result = await embeddings.search("fish", { model: "tiny", limit: 1, filter: "from:200" })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]).toMatchObject({
      summary: { firstMessageId: "1" },
      by: ["meaning", "words"],
      source: account,
    })
    expect((await embeddings.search("fish", { model: "tiny", limit: 1, filter: "date:2030-01-01" })).hits).toEqual([])
    await store.close()
  })

  it("uses the same date, author, chat and negative predicates in word-only fallback", async () => {
    const { store, embeddings } = await setUp()
    const result = await embeddings.search("fish", {
      model: "e5-small",
      limit: 1,
      filter: "chat:9 kind:group from:100 date:2026-10-02 NOT has:file",
      timezone: "UTC",
    })
    expect(result).toMatchObject({
      meaning: "unavailable",
      hits: [{ summary: { firstMessageId: "40" }, by: ["words"] }],
    })
    expect(
      (await embeddings.search("fish", { model: "e5-small", limit: 1, filter: "date:2026-10-03", timezone: "UTC" }))
        .hits,
    ).toEqual([])
    await expect(embeddings.search("fish", { model: "tiny", limit: 1, filter: "from:" })).rejects.toThrow()
    await expect(embeddings.search("fish", { model: "tiny", limit: 1, timezone: "invalid/zone" })).rejects.toThrow()
    expect(
      (await embeddings.search("fish", { model: "e5-small", limit: 1, since: "2026-10-03T00:00:00Z" })).hits,
    ).toEqual([])
    await store.close()
  })

  it("keeps all eligible conversations, rather than the filter's first page of messages", async () => {
    const { store } = await setUp({
      messages: Array.from({ length: 1002 }, (_, index) => message(String(index * 24 + 1), "fish")),
    })
    const { execution } = await prepareLucene(store, account, { text: "from:100", limit: 1 }, {
      app: { command: "chat" },
    } as Messenger)
    expect((await store.queries.conversationEligibility?.(execution))?.conversations).toHaveLength(1002)
    await store.close()
  })

  it("shares tag and attachment eligibility and includes unbuilt matching chats in readiness", async () => {
    const { store, embeddings } = await setUp({
      messages: [message("1", "fish"), { ...message("40", "fish"), attachments: [{ kind: "file", name: "plan.txt" }] }],
    })
    await store.tags.addTags(account, { type: "message", chatId: "9", messageId: "40" }, ["release"])
    expect(
      (await embeddings.search("fish", { model: "e5-small", limit: 10, filter: "tag:release has:file" })).hits,
    ).toMatchObject([{ summary: { firstMessageId: "40" } }])
    expect(
      (await embeddings.search("fish", { model: "e5-small", limit: 10, filter: "tag:release NOT has:file" })).hits,
    ).toEqual([])
    await store.chats.saveChats(account, [
      { id: "10", title: "Unbuilt", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await store.messages.saveMessages(account, "10", [{ ...message("1", "dog"), chatId: "10" }], { via: "history" })
    const found = await embeddings.search("fish", { model: "e5-small", limit: 10, filter: "chat:10" })
    expect(found.hits).toEqual([])
    expect(found.readiness.notBuilt).toEqual(["10"])
    await store.close()
  })

  it("widens only explicitly and qualifies colliding native IDs in results and readiness", async () => {
    const { store, embeddings } = await setUp()
    await registerProvider(store, { name: "test-bot", kind: "messages", aliases: [], command: "chat" })
    const bot = { provider: "test-bot", account: "1" }
    await store.chats.saveChats(bot, [
      { id: "9", title: "Bot group", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await store.messages.saveMessages(bot, "9", [message("40", "fish")], { via: "history" })
    const botDeps = storedDeps(
      { provider: "test-bot", app: { command: "chat" } } as Messenger,
      store,
      bot,
      {} as SendGuard,
    )
    await conversationsService(botDeps).build("9")
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    await embeddingsService(botDeps).embed("9", { model: "tiny", threads: 1 })
    expect(
      (await embeddings.search("fish", { model: "tiny", limit: 10 })).hits.every(
        ({ source }) => source?.provider === "test",
      ),
    ).toBe(true)
    const all = await embeddings.search("fish", { model: "tiny", limit: 10, source: "all" })
    expect(new Set(all.hits.map(({ source }) => source?.provider))).toEqual(new Set(["test", "test-bot"]))
    expect(all.hits.filter(({ chunk }) => chunk.firstMessageId === "40").map(({ locator }) => locator)).toHaveLength(2)
    expect(new Set(all.hits.map(({ locator }) => locator)).size).toBe(all.hits.length)
    expect(all.readiness.searchedByMeaning).toEqual(["test-bot/1/9", "test/1/9"])
    const bots = await embeddings.search("fish", { model: "tiny", limit: 10, source: "bots" })
    expect(bots.hits).toHaveLength(1)
    expect(bots.accounts).toEqual([bot])
    const excluded = await embeddings.search("fish", {
      model: "tiny",
      limit: 10,
      source: "all",
      filter: "date:2030-01-01",
    })
    expect(excluded.hits).toEqual([])
    expect(excluded.readiness.searchedByMeaning).toEqual([])
    await store.close()
  })
})

describe("derived index freshness", () => {
  const edited = (id: string, text: string): Message => ({
    ...message(id, text),
    editedAt: "2026-10-05T00:00:00.000Z",
  })

  it("purges edited-away meaning hits and still counts the edit as pending", async () => {
    const { store, embeddings, conversations, path } = await setUp()
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    await store.messages.saveMessages(account, "9", [edited("40", "zebra")], { via: "live" })

    const found = await embeddings.search("fish", { model: "tiny", limit: 3 })
    expect(found.hits).toEqual([])
    expect(await vectorRows(path, chunkHash("fish"))).toBe(0)
    expect(found.readiness).toMatchObject({ searchedByMeaning: ["9"], stale: ["9"], partial: [] })
    expect((await embeddings.readiness({ chat: "9", model: "tiny" })).chats).toMatchObject([
      {
        state: "stale",
        pending: { new: 0, edited: 1, deleted: 0 },
        vectors: { chunks: 3, current: 2, stale: 1, missing: 0 },
      },
    ])

    await conversations.build("9")
    expect((await embeddings.readiness({ chat: "9", model: "tiny" })).chats).toMatchObject([
      { state: "partial", pending: { edited: 0 }, vectors: { chunks: 3, current: 2, stale: 0, missing: 1 } },
    ])
    await store.close()
  })

  it("keeps a shared hash only while another current chat still uses its actual text", async () => {
    const { store, embeddings, path } = await setUp()
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    const other = { provider: "test", account: "other" }
    await store.messages.saveMessages(other, "9", [message("40", "fish")], { via: "history" })
    await conversationsService(
      storedDeps({ provider: "test", app: { command: "chat" } } as Messenger, store, other, {} as SendGuard),
    ).build("9")
    await store.messages.saveMessages(account, "9", [edited("40", "zebra")], { via: "live" })
    expect(await vectorRows(path, chunkHash("fish"))).toBe(1)
    await store.messages.saveMessages(other, "9", [edited("40", "dog")], { via: "live" })
    expect(await vectorRows(path, chunkHash("fish"))).toBe(0)
    await store.close()
  })

  it("purges the vector of a deleted message's text and never returns the hit", async () => {
    const { store, embeddings, path } = await setUp()
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    await store.messages.markDeleted(account, ["40"], { chatId: "9" })

    expect(await vectorRows(path, chunkHash("fish"))).toBe(0)
    const found = await embeddings.search("fish", { model: "tiny", limit: 3 })
    expect(found.hits.map(({ summary }) => summary.firstMessageId)).not.toContain("40")
    expect((await embeddings.readiness({ chat: "9", model: "tiny" })).chats).toMatchObject([
      { state: "stale", pending: { deleted: 1 }, vectors: { chunks: 3, current: 2, stale: 1, missing: 0 } },
    ])
    await store.close()
  })

  it("drops a hit on a deleted message even when its vector is still there", async () => {
    const { store, embeddings, path } = await setUp()
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    const kept = await vectorOf(path, chunkHash("fish"))
    await store.messages.markDeleted(account, ["40"], { chatId: "9" })
    await store.vectors.saveVectors("local:tiny:4", 4, [{ hash: chunkHash("fish"), vector: kept }])

    const found = await embeddings.search("fish", { model: "tiny", limit: 3 })
    expect(found.hits.map(({ summary }) => summary.firstMessageId)).not.toContain("40")
    await store.close()
  })

  it("keeps the vector another chat's current chunk shares when a message is deleted", async () => {
    const { store, embeddings, conversations, path } = await setUp()
    await store.chats.saveChats(account, [
      { id: "10", title: "Other", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await store.messages.saveMessages(account, "10", [{ ...message("500", "fish"), chatId: "10" }], { via: "history" })
    await conversations.build("10")
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    await embeddings.embed("10", { model: "tiny", threads: 1 })
    await store.messages.markDeleted(account, ["40"], { chatId: "9" })

    expect(await vectorRows(path, chunkHash("fish"))).toBe(1)
    const [top] = (await embeddings.search("fish", { model: "tiny", limit: 5 })).hits
    expect(top).toMatchObject({ summary: { chatId: "10", firstMessageId: "500" }, stale: false })
    const inNine = (await embeddings.search("fish", { model: "tiny", chat: "9", limit: 5 })).hits
    expect(inNine.map(({ summary }) => summary.firstMessageId)).not.toContain("40")
    await store.close()
  })

  it("counts a message saved after the build as pending, though its word match stays hidden until a rebuild", async () => {
    const { store, embeddings } = await setUp()
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    await store.messages.saveMessages(account, "9", [message("120", "zebra")], { via: "live" })

    const found = await embeddings.search("zebra", { model: "tiny", limit: 5 })
    expect(found.hits.filter(({ by }) => by.includes("words"))).toEqual([])
    expect(found.readiness).toMatchObject({ stale: ["9"], notBuilt: [] })
    expect((await embeddings.readiness({ model: "tiny" })).chats).toMatchObject([
      { chat: "9", state: "stale", pending: { new: 1, edited: 0, deleted: 0 }, vectors: { current: 3, missing: 0 } },
    ])
    await store.close()
  })

  it("names a chat missing some vectors of the model as partial, and keeps embeddedOnlyElsewhere", async () => {
    const { store, embeddings, conversations } = await setUp()
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    await embeddings.embed("9", { model: "tiny-2", threads: 1 })
    await store.messages.saveMessages(account, "9", [message("120", "zebra")], { via: "live" })
    await conversations.build("9")
    await embeddings.embed("9", { model: "tiny", threads: 1 })

    const found = await embeddings.search("zebra", { model: "tiny-2", limit: 5 })
    expect(found.embeddedOnlyElsewhere).toEqual([])
    expect(found.readiness).toEqual({
      searchedByMeaning: ["9"],
      wordsOnly: [],
      partial: ["9"],
      stale: [],
      notBuilt: [],
    })
    expect((await embeddings.readiness({ model: "tiny-2" })).chats).toMatchObject([
      { state: "partial", vectors: { chunks: 4, current: 3, stale: 0, missing: 1 } },
    ])
    await store.close()
  })

  it("keeps the exact word match and drops nonpositive meaning hits before fusion", async () => {
    const { store, embeddings, conversations } = await setUp({
      messages: [message("1", "cat dog"), message("40", "fish")],
    })
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    await store.messages.saveMessages(account, "9", [message("80", "zebra")], { via: "live" })
    await conversations.build("9")

    const { hits } = await embeddings.search("zebra", { model: "tiny", limit: 5 })
    expect(hits.map(({ summary, score, by }) => [summary.firstMessageId, score, by])).toEqual([["80", null, ["words"]]])
    await store.close()
  })

  it("applies the measured e5 floor before ranking, preserving exact words and current readiness", async () => {
    const { store } = await setUp({
      messages: [message("1", "cat dog"), message("40", "fish"), message("80", "zebra")],
    })
    const installed = vi.spyOn(embeddingRuntime, "isTextModelInstalled").mockReturnValue(true)
    const nearest = vi.spyOn(store.vectors, "nearestConversations").mockImplementation(async () =>
      (await store.conversations.conversations(account, "9", { limit: 10 })).items
        .map((summary) => ({
          summary,
          chunk: { firstMessageId: summary.firstMessageId, lastMessageId: summary.firstMessageId },
          score: summary.firstMessageId === "1" ? 0.8001 : summary.firstMessageId === "40" ? 0.8 : 0.79,
          stale: false,
        }))
        .sort((a, b) => b.score - a.score),
    )
    const model = textModel("e5-small")
    const embeddings = embeddingsService({
      ...storedDeps({ provider: "test", app: { command: "chat" } } as Messenger, store, account, {} as SendGuard),
      embedders: {
        get: async () => ({ model, embed: async () => [new Float32Array(384)], close: async () => {} }),
        reranker: () => Promise.reject(new Error("no reranker")),
        close: async () => {},
      },
    })
    try {
      const result = await embeddings.search("zebra", { model: "e5-small", limit: 10 })
      expect(result.hits.map(({ summary, by }) => [summary.firstMessageId, by])).toEqual([
        ["1", ["meaning"]],
        ["80", ["words"]],
      ])
      const noAnswer = await embeddings.search("nonexistent", { model: "e5-small", limit: 10 })
      expect(noAnswer.hits.map(({ summary }) => summary.firstMessageId)).toEqual(["1"])
      expect(result.meaning).toBe("searched")
    } finally {
      nearest.mockRestore()
      installed.mockRestore()
      await store.close()
    }
  })

  it("rejects blank and oversized topic queries before refreshing or reading indexes", async () => {
    const { store, embeddings } = await setUp()
    const index = vi.spyOn(store.searchIndex, "fillSearchIndex")
    for (const query of ["", "  ", "é".repeat(4097)])
      await expect(embeddings.search(query, { model: "tiny", limit: 10 })).rejects.toMatchObject({
        code: "validation_error",
      })
    expect(index).not.toHaveBeenCalled()
    await store.close()
  })

  it("searches by words alone when the model is not downloaded, and says so", async () => {
    const { store, embeddings } = await setUp()
    const found = await embeddings.search("fish", { model: "e5-small", limit: 5 })
    expect(found).toMatchObject({
      model: "e5-small",
      meaning: "unavailable",
      hits: [{ summary: { firstMessageId: "40" }, score: null, by: ["words"], stale: false }],
      readiness: { searchedByMeaning: [], wordsOnly: ["9"], partial: [] },
    })
    await store.close()
  })

  it("reports a chat never built, one built under older rules, and readiness with no hits", async () => {
    const { store, embeddings, conversations, path } = await setUp({ build: false })
    expect((await embeddings.readiness({ model: "tiny" })).chats).toEqual([])
    expect((await embeddings.readiness({ chat: "9", model: "tiny" })).chats).toEqual([
      {
        chat: "9",
        state: "not-built",
        graph: null,
        pending: { new: 0, edited: 0, deleted: 0 },
        vectors: { chunks: 0, current: 0, stale: 0, missing: 0 },
      },
    ])
    const unbuilt = await embeddings.search("fish", { model: "tiny", limit: 5 })
    expect([unbuilt.hits, unbuilt.readiness.notBuilt]).toEqual([[], ["9"]])

    await conversations.build("9")
    const nothing = await embeddings.search("kitten", { model: "tiny", chat: "9", limit: 5 })
    expect([nothing.hits, nothing.readiness]).toMatchObject([[], { wordsOnly: ["9"], notBuilt: [], stale: [] }])
    expect((await embeddings.readiness({ model: "tiny" })).chats).toMatchObject([
      { state: "words-only", graph: { outdatedRules: false }, vectors: { chunks: 3, missing: 3 } },
    ])

    await store.messages.saveMessages(
      account,
      "9",
      [{ ...message("40", "zebra"), editedAt: "2026-10-05T00:00:00.000Z" }],
      {
        via: "live",
      },
    )
    const edited = await embeddings.search("kitten", { model: "tiny", chat: "9", limit: 5 })
    expect(edited.readiness).toMatchObject({ searchedByMeaning: [], wordsOnly: ["9"], stale: ["9"] })
    await conversations.build("9")

    await withDatabase(path, (run) => run("UPDATE conversation_state SET algorithm_version = 1"))
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    expect((await embeddings.readiness({ model: "tiny" })).chats).toMatchObject([
      { state: "stale", graph: { rulesVersion: 1, outdatedRules: true } },
    ])
    await store.close()
  })
})

describe("catching up without --chat", () => {
  const inChat = (chatId: string, one: Message): Message => ({ ...one, chatId })
  const withChats = async () => {
    const set = await setUp()
    await set.store.chats.saveChats(account, [
      { id: "10", title: "Other", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
      { id: "11", title: "Zoe", kind: "dialog", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await set.store.messages.saveMessages(account, "10", [inChat("10", message("200", "fish dog"))], { via: "history" })
    await set.store.messages.saveMessages(account, "11", [inChat("11", message("300", "cat"))], { via: "history" })
    return set
  }

  it("**rebuilds a changed chat before building a group never built**, within --max-chats, and names the rest", async () => {
    const { store, embeddings } = await withChats()
    await store.messages.saveMessages(account, "9", [message("120", "zebra")], { via: "live" })
    expect(await embeddings.readiness({ model: "tiny" })).toMatchObject({ unbuiltGroups: 1 })
    expect(await embeddings.readiness({ chat: "9", model: "tiny" })).not.toHaveProperty("unbuiltGroups")

    const first = await embeddings.refresh({ model: "tiny", maxChats: 1, embed: false })
    expect(first.built.map(({ chat }) => chat)).toEqual(["9"])
    expect([first.embedded, first.left]).toEqual([[], [{ chat: "10", needs: "build" }]])

    const second = await embeddings.refresh({ model: "tiny", embed: false })
    expect([second.built.map(({ chat }) => chat), second.left]).toEqual([["10"], []])
    const after = await embeddings.readiness({ model: "tiny" })
    expect([after.chats.map(({ chat }) => chat), after.unbuiltGroups]).toEqual([["10", "9"], 0])
    await store.close()
  })

  it("**embeds what is left within --max-chunks**, the chats just built first, and resumes on the next run", async () => {
    const { store, embeddings } = await withChats()

    const first = await embeddings.refresh({ model: "tiny", maxChunks: 2, threads: 1 })
    expect(first).toMatchObject({
      model: "tiny",
      modelAvailable: true,
      built: [{ chat: "10" }],
      embedded: [
        { chat: "10", embedded: 1 },
        { chat: "9", embedded: 1 },
      ],
      left: [{ chat: "9", needs: "embed" }],
    })

    const second = await embeddings.refresh({ model: "tiny", threads: 1 })
    expect([second.built, second.embedded, second.left]).toEqual([
      [],
      [{ chat: "9", model: "tiny", embedded: 2, skipped: 0 }],
      [],
    ])
    expect((await embeddings.readiness({ model: "tiny" })).chats.map(({ state }) => state)).toEqual(["ready", "ready"])
    expect((await embeddings.refresh({ model: "tiny" })).embedded).toEqual([])
    await store.close()
  })

  it("refreshes only the chat named, even one never built", async () => {
    const { store, embeddings } = await withChats()
    const done = await embeddings.refresh({ chat: "11", model: "tiny", threads: 1 })
    expect(done).toMatchObject({ built: [{ chat: "11" }], embedded: [{ chat: "11", embedded: 1 }], left: [] })
    await store.close()
  })

  it("builds but embeds nothing when the model is not downloaded, and an embed-only run refuses naming the download", async () => {
    const { store, embeddings } = await withChats()
    const done = await embeddings.refresh({})
    expect(done).toMatchObject({ model: "e5-small", modelAvailable: false, built: [{ chat: "10" }], embedded: [] })
    expect(done.left).toEqual([
      { chat: "9", needs: "embed" },
      { chat: "10", needs: "embed" },
    ])
    await expect(embeddings.refresh({ build: false })).rejects.toThrow("models download e5-small")
    await store.close()
  })

  it("stops one chat's embedding at --max-chunks, and the next run goes on from there", async () => {
    const { store, embeddings } = await setUp()
    expect(await embeddings.embed("9", { model: "tiny", threads: 1, maxChunks: 2 })).toMatchObject({ embedded: 2 })
    expect(await embeddings.status("9", "tiny")).toMatchObject({ left: 1 })
    expect(await embeddings.embed("9", { model: "tiny", threads: 1 })).toMatchObject({ embedded: 1 })
    await store.close()
  })
})

describe("related conversations", () => {
  it("**finds the conversations like a message's own**, never that one, with no model downloaded", async () => {
    const { store, embeddings } = await setUp()
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    vi.stubEnv("WIRECAT_STATE_DIR", mkdtempSync(join(tmpdir(), "no-models-")))

    const found = await embeddings.related("9", "80", { model: "tiny", limit: 5 })
    expect(found.source.firstMessageId).toBe("80")
    expect(found.hits.map(({ summary }) => summary.firstMessageId)).toEqual(["1", "40"])
    expect(found.hits[0]).toMatchObject({ by: ["meaning"], stale: false })
    expect(found.hits[0]?.score).toBeGreaterThan(found.hits[1]?.score ?? 1)
    expect(found.readiness).toMatchObject({ searchedByMeaning: ["9"], stale: [], notBuilt: [] })
    expect((await embeddings.related("9", "2", { model: "tiny", limit: 1 })).hits).toHaveLength(1)
    await store.close()
  })

  it("refuses with the command to run: never built, never embedded, its message changed since", async () => {
    const unbuilt = await setUp({ build: false })
    await expect(unbuilt.embeddings.related("9", "80", { model: "tiny", limit: 5 })).rejects.toThrow(
      "conversations links rebuild --chat 9",
    )
    await unbuilt.store.close()

    const { store, embeddings, conversations } = await setUp()
    await expect(embeddings.related("9", "80", { model: "tiny", limit: 5 })).rejects.toThrow(
      "conversations embed --chat 9",
    )
    await expect(embeddings.related("9", "999", { model: "tiny", limit: 5 })).rejects.toThrow(
      "message 999 is in no conversation",
    )
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    await store.messages.saveMessages(
      account,
      "9",
      [{ ...message("80", "zebra"), editedAt: "2026-10-05T00:00:00.000Z" }],
      {
        via: "live",
      },
    )
    await expect(embeddings.related("9", "80", { model: "tiny", limit: 5 })).rejects.toThrow(
      "conversations links rebuild --chat 9",
    )
    await conversations.build("9")
    await embeddings.embed("9", { model: "tiny", threads: 1 })
    expect((await embeddings.related("9", "80", { model: "tiny", limit: 5 })).hits[0]?.score).toBeLessThan(0.5)
    await store.close()
  })
})

const withDatabase = async <T>(path: string, body: (run: (sql: string) => Record<string, unknown>[]) => T) => {
  const database = await openCache(path)
  try {
    return body((sql) =>
      database
        .prepare(sql)
        .all()
        .map((row) => ({ ...row })),
    )
  } finally {
    database.close()
  }
}

const vectorRows = (path: string, hash: string) =>
  withDatabase(path, (run) => Number(run(`SELECT count(*) AS n FROM embeddings WHERE content_hash = '${hash}'`)[0]?.n))

const vectorOf = (path: string, hash: string) =>
  withDatabase(path, (run) => {
    const blob = run(`SELECT vector FROM embeddings WHERE content_hash = '${hash}'`)[0]?.vector as Uint8Array
    return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))
  })
