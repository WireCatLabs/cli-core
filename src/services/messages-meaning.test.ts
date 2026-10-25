import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import type { Message } from "../domain/models.js"
import type { TextModel } from "../embeddings/models.js"
import type { SendGuard } from "../sends/guard.js"
import { openCache } from "../store/open.js"
import { type MessageStore, openStore } from "../store/store.js"
import { storedDeps } from "./deps.js"
import { embeddingsService } from "./embeddings.js"
import { messagesService } from "./messages.js"
import { searchStore } from "./messages-archive-search.js"
import { meaningLane } from "./messages-meaning.js"
import { embedNotes } from "./notes-search.js"
import { searchAll } from "./search-all.js"

const tiny: TextModel = {
  id: "e5-small",
  title: "the tiny fixture under the default model's name",
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
  return { ...real, textModel: (id: string) => (id === "e5-small" ? tiny : real.textModel(id)) }
})

const opened = vi.hoisted(() => ({ models: 0 }))
vi.mock("../embeddings/embed.js", async (original) => {
  const real = await original<typeof import("../embeddings/embed.js")>()
  return {
    ...real,
    openEmbedder: (...args: Parameters<typeof real.openEmbedder>) => {
      opened.models++
      return real.openEmbedder(...args)
    },
  }
})

const account = { provider: "test", account: "1" }
const stores: MessageStore[] = []

const message = (id: string, text: string, chatId = "9"): Message => ({
  id,
  chatId,
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
    fileURLToPath(new URL("../embeddings/fixtures/tiny", import.meta.url)),
    join(models, "models", "text", "e5-small"),
  )
}

const setUp = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "discover-meaning-")), "m.db")
  const store = await openStore({ path })
  stores.push(store)
  await store.chats.saveChats(
    account,
    ["9", "10"].map((id) => ({
      id,
      title: `Chat ${id}`,
      kind: "group" as const,
      unreadCount: 0,
      lastMessageAt: null,
      participantsCount: null,
    })),
  )
  await store.messages.saveMessages(
    account,
    "9",
    [message("1", "cat dog"), message("2", "kitten"), message("3", "fish")],
    {
      via: "history",
    },
  )
  await store.messages.saveMessages(account, "10", [message("4", "kitten", "10")], { via: "history" })
  await store.searchIndex.fillSearchIndex({})
  await store.searchIndex.fillStems({})
  const deps = storedDeps({ provider: "test", app: { command: "chat" } } as Messenger, store, account, {} as SendGuard)
  const discover = (text: string, extra: object = {}) =>
    searchStore(store, account, { text, discover: true, limit: 10, timezone: "UTC", ...extra }, {}, meaningLane(deps))
  const all = (text: string, extra: object = {}) =>
    messagesService(deps).searchAll({ text, limit: 10, timezone: "UTC", only: ["messages"], ...extra })
  return { path, store, embeddings: embeddingsService(deps), discover, all }
}

beforeEach(() => {
  models = mkdtempSync(join(tmpdir(), "models-"))
  vi.stubEnv("WIRECAT_STATE_DIR", models)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const store of stores.splice(0)) await store.close()
})

describe("discovery by meaning", () => {
  it("searches by words alone and says why while the model is not downloaded", async () => {
    const { discover } = await setUp()

    const found = await discover("cat")

    expect(found.items.map(({ id }) => id)).toEqual(["1"])
    expect(found.meaningSkipped).toEqual({
      reason: "e5-small is not downloaded",
      step: "models.download",
      model: "e5-small",
    })
  })

  it("says the messages need vectors when the model is there but none were built", async () => {
    download()
    const { discover } = await setUp()

    expect((await discover("cat")).meaningSkipped).toMatchObject({ step: "conversations.rebuild" })
  })

  it("**finds a message in other words** once the rebuild gave messages vectors, fused with the word hits", async () => {
    download()
    const { discover, embeddings } = await setUp()

    const refreshed = await embeddings.refresh({ threads: 1 })
    expect(refreshed.messages).toEqual({ embedded: 4, left: 0 })
    expect((await embeddings.refresh({ threads: 1 })).messages).toEqual({ embedded: 0, left: 0 })

    const found = await discover("cat")
    expect(found.meaningSkipped).toBeUndefined()
    expect(found.query?.discovery?.meaning).toEqual({ model: "e5-small", candidates: 4 })
    const byId = new Map(found.items.map((hit) => [hit.id, hit.discovery?.foundBy]))
    expect(byId.get("1")).toEqual(["words", "meaning"])
    expect(byId.get("2")).toEqual(["meaning"])
    expect(found.items[0]?.id).toBe("1")
  })

  it("keeps the question's filters on the meaning hits", async () => {
    download()
    const { discover, embeddings } = await setUp()
    await embeddings.refresh({ threads: 1 })

    const found = await discover("cat chat:10")

    expect(found.items.map(({ chatId }) => chatId)).toEqual(["10"])
  })

  describe("searches strictly, words only, when the filters are more than plain terms", () => {
    const strict = async (text: string) => {
      download()
      const { store, discover, embeddings } = await setUp()
      await store.messages.saveMessages(account, "9", [{ ...message("5", "kitten"), senderId: "200" }], {
        via: "history",
      })
      await embeddings.refresh({ threads: 1 })
      const found = await discover(text)
      expect(found.query?.discovery).toBeUndefined()
      expect(found.items.some(({ discovery }) => discovery?.foundBy)).toBe(false)
      return found.items.map(({ id }) => id).sort()
    }

    it("a negated chat leaves its messages out", async () => {
      expect(await strict("kitten -chat:10")).toEqual(["2", "5"])
    })

    it("a negated sender leaves theirs out", async () => {
      expect(await strict("kitten -from:200")).toEqual(["2", "4"])
    })

    it("a filter under OR with the words", async () => {
      expect(await strict("cat OR chat:10")).toEqual(["1", "4"])
    })

    it("a group of filters", async () => {
      expect(await strict("kitten -(chat:9 from:200)")).toEqual(["2", "4"])
    })
  })

  it("re-embeds an edited message and forgets a deleted one", async () => {
    download()
    const { store, discover, embeddings } = await setUp()
    await embeddings.refresh({ threads: 1 })

    await store.messages.saveMessages(account, "9", [{ ...message("3", "kitten"), editedAt: "2026-10-02T00:00:00Z" }], {
      via: "history",
    })
    await store.messages.markDeleted(account, ["2"], { chatId: "9" })
    expect((await embeddings.refresh({ threads: 1 })).messages).toEqual({ embedded: 1, left: 0 })

    const meaningOnly = (await discover("cat")).items.filter((hit) => hit.discovery?.foundBy?.join() === "meaning")
    expect(meaningOnly.map(({ id }) => id).sort()).toEqual(["3", "4"])
  })

  it("leaves strict search alone: no meaning and no note", async () => {
    download()
    const { discover, embeddings } = await setUp()
    await embeddings.refresh({ threads: 1 })

    const found = await discover("cat", { exact: true })

    expect(found.meaningSkipped).toBeUndefined()
    expect(found.items.map(({ id }) => id)).toEqual(["1"])
  })

  it("never embeds messages during a search's catch-up or when told not to", async () => {
    download()
    const { embeddings } = await setUp()

    expect((await embeddings.refresh({ threads: 1, messages: false })).messages).toBeUndefined()
  })
})

describe("search all by meaning", () => {
  it("fuses the messages nearest in meaning into the messages list, saying which search found each", async () => {
    download()
    const { all, embeddings } = await setUp()
    await embeddings.refresh({ threads: 1 })

    const found = await all("cat")

    expect(found.messages).toEqual({ by: "words and meaning" })
    const byRef = new Map(found.items.map((item) => [item.ref.split("/").at(-1), item.foundBy]))
    expect(byRef.get("1")).toEqual(["words", "meaning"])
    expect(byRef.get("2")).toEqual(["meaning"])
    expect(found.items[0]?.ref).toMatch(/\/1$/)
  })

  it("says which step is missing while the model or the vectors are", async () => {
    const { all } = await setUp()
    expect((await all("cat")).messages).toEqual({
      by: "words",
      meaningSkipped: { reason: "e5-small is not downloaded", step: "models.download", model: "e5-small" },
    })
    download()
    expect((await all("cat")).messages?.meaningSkipped).toMatchObject({ step: "conversations.rebuild" })
    expect((await all("cat")).items.map(({ foundBy }) => foundBy)).toEqual([["words"]])
  })

  it("loads the model once for messages and notes alike", async () => {
    download()
    const { store, embeddings, all } = await setUp()
    await embeddings.refresh({ threads: 1 })
    await store.notes.addNote({ text: "kitten" })
    await embedNotes(store, { threads: 1 })
    opened.models = 0

    const found = await all("cat", { only: ["messages", "notes"] })

    expect(found.messages?.by).toBe("words and meaning")
    expect(found.notes?.by).toBe("words and meaning")
    expect(opened.models).toBe(1)
  })

  it("takes a lane built from a store and env alone, as memo has them", async () => {
    download()
    const { store, embeddings } = await setUp()
    await embeddings.refresh({ threads: 1 })
    const lane = meaningLane({ env: process.env, store: async () => store, messenger: { app: { command: "memo" } } })

    const found = await searchAll(store, account, { text: "cat", limit: 10, only: ["messages"] }, {}, undefined, lane)

    expect(found.messages).toEqual({ by: "words and meaning" })
  })

  it("leaves --exact and the server's own hits to words, with no note", async () => {
    download()
    const { all, embeddings } = await setUp()
    await embeddings.refresh({ threads: 1 })

    for (const extra of [{ exact: true }, { backend: "server" }]) {
      const found = await all("cat", extra)
      expect(found.messages).toBeUndefined()
      expect(found.items.map(({ foundBy }) => foundBy.join())).toEqual(extra.exact ? ["words"] : [])
    }
  })

  it("keeps the query's filters on the meaning hits, and skips meaning when NOT or OR would change them", async () => {
    download()
    const { all, embeddings } = await setUp()
    await embeddings.refresh({ threads: 1 })

    expect((await all("cat chat:10")).items.map(({ ref }) => ref.split("/").at(-2))).toEqual(["10"])
    const negated = await all("cat -chat:10")
    expect(negated.items.map(({ foundBy }) => foundBy)).toEqual([["words"]])
    expect(negated.messages?.meaningSkipped?.reason).toMatch(/NOT/)
    expect((await all("cat OR chat:10")).messages?.by).toBe("words")
    const either = await all("cat OR fish")
    expect(either.messages).toEqual({ by: "words and meaning" })
    expect(either.items.some(({ foundBy }) => foundBy.join() === "meaning")).toBe(true)
  })

  it("never brings back a chat hidden from search", async () => {
    download()
    const { path, all, embeddings } = await setUp()
    await embeddings.refresh({ threads: 1 })
    const database = await openCache(path)
    database.prepare("UPDATE chats SET searchable = 0 WHERE external_id = ?").run("10")
    database.close()

    const found = await all("cat")

    expect(found.messages?.by).toBe("words and meaning")
    expect(found.items.map(({ ref }) => ref.split("/").at(-2))).not.toContain("10")
  })
})
