import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { provide } from "../cli/context.js"
import type { TrackerRecords } from "../domain/tracker.js"
import type { TextModel } from "../embeddings/models.js"
import { openSqlite } from "../store/sqlite/open.js"
import { type MessageStore, openStore } from "../store/store.js"
import { addTrackerCommands } from "../tracker/index.js"
import { fakeTrackerSource } from "../tracker/testing/index.js"
import { embedTracker } from "./notes-search.js"
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
  return { ...real, textModel: (id: string) => (id === "e5-small" ? tiny : real.textModel(id)), meaningFloor: () => 0 }
})

const ME = { provider: "telegram", account: "100" }
const LINEAR = { provider: "linear", account: "user-1" }
const OTHER = { provider: "linear", account: "user-2" }
const NOW = Date.UTC(2026, 10, 17)
const opened: MessageStore[] = []

let models = ""
beforeEach(() => {
  models = mkdtempSync(join(tmpdir(), "models-"))
  vi.stubEnv("WIRECAT_STATE_DIR", models)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const store of opened.splice(0)) await store.close()
})

const download = () => {
  mkdirSync(join(models, "models", "text"), { recursive: true })
  symlinkSync(
    fileURLToPath(new URL("../embeddings/fixtures/tiny", import.meta.url)),
    join(models, "models", "text", "e5-small"),
  )
}

const issue = (externalId: string, title: string, description?: string): TrackerRecords["issue"] => ({
  externalId,
  key: externalId.toUpperCase(),
  title,
  ...(description === undefined ? {} : { description }),
  labels: [],
  updatedAt: NOW,
})

const trackerStore = async (path = join(mkdtempSync(join(tmpdir(), "tracker-meaning-")), "store.db")) => {
  const store = await openStore({ path })
  opened.push(store)
  await store.tracker.save(LINEAR, "issue", [issue("i1", "cat"), issue("i2", "zebra")], NOW)
  await store.tracker.save(LINEAR, "comment", [{ externalId: "c1", issue: "i2", body: "fish", updatedAt: NOW }], NOW)
  await store.tracker.save(OTHER, "issue", [issue("o1", "kitten cat")], NOW)
  return store
}

const tracker = (store: MessageStore, text: string, extra: Partial<Parameters<typeof searchAll>[2]> = {}) =>
  searchAll(store, ME, { text, limit: 10, only: ["tracker"], ...extra })

describe("issues, projects and comments by meaning", () => {
  it("finds an issue by a word of the same meaning, and by words and meaning when a word matches", async () => {
    download()
    const store = await trackerStore()
    expect(await embedTracker(store, { threads: 1 })).toEqual({ model: "e5-small", embedded: 4, left: false })

    const paraphrase = await tracker(store, "kitten", { scope: { tracker: [LINEAR] } })
    expect(paraphrase.tracker).toEqual({ by: "words and meaning" })
    expect(paraphrase.items.map(({ ref, foundBy }) => [ref, foundBy])).toEqual([
      ["tracker:linear/user-1/issue/i1", ["meaning"]],
    ])

    const both = await tracker(store, "cat")
    expect(both.items.find(({ ref }) => ref === "tracker:linear/user-1/issue/i1")?.foundBy).toEqual([
      "words",
      "meaning",
    ])
    expect(new Set(both.items.map(({ account }) => account))).toEqual(new Set(["user-1", "user-2"]))
  })

  it("never brings an account it was not asked to read", async () => {
    download()
    const store = await trackerStore()
    await embedTracker(store, { threads: 1 })
    const found = await tracker(store, "kitten", { scope: { tracker: [OTHER] } })
    expect(found.items.map(({ ref }) => ref)).toEqual(["tracker:linear/user-2/issue/o1"])
  })

  it("searches words only with --exact, a field, or no vectors, and says why", async () => {
    download()
    const store = await trackerStore()
    expect((await tracker(store, "kitten")).tracker).toEqual({
      by: "words",
      meaningSkipped: "no issue, project or comment has vectors of e5-small yet, so only words were matched",
    })
    await embedTracker(store, { threads: 1 })
    const exact = await tracker(store, "kitten", { exact: true, scope: { tracker: [LINEAR] } })
    expect(exact.tracker).toEqual({ by: "words", meaningSkipped: "--exact searches words as written" })
    expect(exact.items).toEqual([])
    expect((await tracker(store, "title:kitten")).tracker?.meaningSkipped).toBe(
      "the query has fields or operators, which meaning cannot follow",
    )
  })

  it("stops embedding before the deadline and says how many chunks are left", async () => {
    download()
    const store = await trackerStore()
    expect(await embedTracker(store, { threads: 1, deadline: { endsAt: Date.now() + 1_000, ms: 45_000 } })).toEqual({
      model: "e5-small",
      embedded: 0,
      left: true,
      stopped: "deadline",
      remaining: 4,
    })
  })

  it("embeds the items stored before they had chunks", async () => {
    download()
    const path = join(mkdtempSync(join(tmpdir(), "tracker-meaning-")), "store.db")
    const store = await trackerStore(path)
    const { database } = await openSqlite(path)
    database.exec("DELETE FROM chunks WHERE chunkable_type = 'tracker_item'")
    database.close()
    expect(await embedTracker(store, { threads: 1 })).toMatchObject({ embedded: 4, left: false })
  })

  it("indexes new issues on sync --embed, and keeps --embed in the step that goes on", async () => {
    download()
    const store = await trackerStore()
    const source = fakeTrackerSource({ rows: { issue: [issue("n1", "dog"), issue("n2", "fish")] }, pageSize: 1 })
    const cli = async (...args: string[]) => {
      let data = ""
      const root = new Command("tracker").exitOverride().option("--json")
      addTrackerCommands(root, {
        app: { command: "tracker", appName: "tracker-meaning", envPrefix: "TRACKER", description: "", version: "1" },
        open: async () => ({ account: LINEAR, store, source: () => source }),
        now: () => NOW,
      })
      provide(root, { streams: { data: (text: string) => (data += text), diagnostic: () => {} } } as never)
      await root.parseAsync([...args, "--json"], { from: "user" })
      return JSON.parse(data) as { item: Record<string, unknown>; next?: { args: Record<string, unknown> }[] }
    }
    const cut = await cli("sync", "--embed", "--max-pages", "1")
    expect(cut.item.embeddings).toBeUndefined()
    expect(cut.next?.[0]?.args).toEqual({ max_pages: 1, embed: true })
    const done = await cli("sync", "--embed")
    expect(done.item.embeddings).toMatchObject({ model: "e5-small", left: false })
    expect((await tracker(store, "dog", { scope: { tracker: [LINEAR] } })).tracker).toEqual({
      by: "words and meaning",
    })
  })
})
