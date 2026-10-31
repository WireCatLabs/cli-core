import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseLucene } from "@wirecat/cli-base/query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Embedder } from "../embeddings/embed.js"
import { type TextModel, vectorModelKey } from "../embeddings/models.js"
import { SEARCH_QUERY } from "../search/lucene/types.js"
import { type MessageStore, openStore } from "../store/store.js"
import { fieldsOfQuery, meaningWords, searchNotes } from "./notes-search.js"

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

const DAY = 86_400_000
const START = Date.UTC(2026, 9, 1, 12)
const opened: MessageStore[] = []
let env: NodeJS.ProcessEnv = {}

beforeEach(() => {
  const state = mkdtempSync(join(tmpdir(), "models-"))
  env = { WIRECAT_STATE_DIR: state }
  mkdirSync(join(state, "models", "text"), { recursive: true })
  symlinkSync(
    fileURLToPath(new URL("../embeddings/fixtures/tiny", import.meta.url)),
    join(state, "models", "text", "e5-small"),
  )
})
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

type Seed = { title: string; text: string; tags?: string[]; day?: number }

const seeded = async (notes: Seed[]) => {
  let now = START
  const store = await openStore({
    path: join(mkdtempSync(join(tmpdir(), "meaning-filters-")), "store.db"),
    now: () => now,
  })
  opened.push(store)
  const folder = await store.notes.addFolder({ name: "notes" })
  for (const [index, { title, text, tags, day = 0 }] of notes.entries()) {
    now = START + day * DAY
    const { note } = await store.notes.saveFileNote({ folderId: folder.id, path: `n${index}.md`, title, text })
    if (tags) await store.notes.replaceFileTags(note.id, tags)
  }
  now = START + 30 * DAY
  return store
}

const NOTES: Seed[] = [
  { title: "Harbour plan", text: "the plan for the harbour", tags: ["work"], day: 0 },
  { title: "Garden plan", text: "the plan for the garden", day: 0 },
  { title: "Kitchen", text: "the kitchen tiles", tags: ["work"], day: 5 },
  { title: "Holiday", text: "the trip to the coast", day: 5 },
]

const NEAR = Float32Array.from([1, 0, 0, 0])
const FAR = Float32Array.from([-1, 0, 0, 0])
// The fixture model knows five words; every query reads as NEAR, and each note's vector is set below.
const embedder: Embedder = {
  model: tiny,
  embed: async (texts) => texts.map(() => NEAR),
  close: async () => {},
}
const embedders = { get: async () => embedder }

const vectors = async (store: MessageStore, near: (text: string) => boolean = () => true) => {
  const key = vectorModelKey(tiny)
  const chunks = await store.notes.chunksToEmbed(key, { limit: 10_000 })
  await store.vectors.saveVectors(
    key,
    tiny.dims,
    chunks.map(({ hash, text }) => ({ hash, vector: near(text) ? NEAR : FAR })),
  )
}

const search = async (store: MessageStore, query: string, options: Parameters<typeof searchNotes>[2] = {}) => {
  const found = await searchNotes(store, query, { env, embedders, timezone: "UTC", ...options })
  return { ...found, titles: found.hits.map(({ title }) => title).sort() }
}

describe("field terms in the query hold for hits found by meaning", () => {
  it("a query of fields alone lists only the matching notes and is not searched by meaning", async () => {
    const store = await seeded(NOTES)
    await vectors(store)
    const tagged = await search(store, "tag:work")
    expect(tagged.titles).toEqual(["Harbour plan", "Kitchen"])
    expect(tagged.by).toBe("words")
    const dated = await search(store, "date:2026-10-06")
    expect(dated.titles).toEqual(["Holiday", "Kitchen"])
  })

  it("free words drive the meaning half, and every hit keeps the query's tag and date", async () => {
    const store = await seeded(NOTES)
    await vectors(store)
    const found = await search(store, "plan tag:work")
    expect(found.by).toBe("words and meaning")
    expect(found.titles).toEqual(["Harbour plan", "Kitchen"])
    expect(found.hits.find(({ title }) => title === "Kitchen")?.found_by).toEqual(["meaning"])
    expect((await search(store, "plan")).titles).toEqual(["Garden plan", "Harbour plan", "Holiday", "Kitchen"])
    expect((await search(store, "plan date>=2026-10-03")).titles).toEqual(["Holiday", "Kitchen"])
  })

  it("an excluded field or word removes meaning hits too", async () => {
    const store = await seeded(NOTES)
    await vectors(store)
    expect((await search(store, "plan -tag:work")).titles).toEqual(["Garden plan", "Holiday"])
    expect((await search(store, "plan -kitchen")).titles).toEqual(["Garden plan", "Harbour plan", "Holiday"])
  })

  it("a field joined by OR to the words narrows nothing", async () => {
    const store = await seeded(NOTES)
    await vectors(store)
    expect((await search(store, "plan OR tag:work")).titles).toEqual([
      "Garden plan",
      "Harbour plan",
      "Holiday",
      "Kitchen",
    ])
  })

  it("--filter checks every meaning candidate, however many notes it matches", async () => {
    const notes: Seed[] = [
      { title: "Lighthouse", text: "the old lighthouse", tags: ["work"], day: 0 },
      ...Array.from({ length: 520 }, (_, index) => ({
        title: `Filler ${index}`,
        text: `filler ${index}`,
        tags: ["work"],
        day: 1,
      })),
    ]
    const store = await seeded(notes)
    await vectors(store, (text) => text.includes("lighthouse"))
    const found = await search(store, "beacon", { filter: "tag:work" })
    expect(found.hits[0]).toMatchObject({ title: "Lighthouse", found_by: ["meaning"] })
  })
})

describe("the parts of a query the meaning half reads", () => {
  const root = (query: string) => parseLucene(query, { ...SEARCH_QUERY, defaultField: "text" }).root
  const fields = (query: string) => {
    const node = fieldsOfQuery(root(query))
    return node === undefined ? undefined : JSON.stringify(node, ["kind", "field", "value", "occur", "clauses", "node"])
  }

  it.each([
    ["plan", undefined],
    ['"harbour plan" OR garden', undefined],
    ["date:today", JSON.stringify({ kind: "predicate", field: "date", value: "today" })],
  ])("%s narrows meaning hits to %s", (query, expected) => {
    expect(fields(query)).toBe(expected)
  })

  it("keeps an excluded word and stands in for a wanted one", () => {
    expect(fields("plan -kitchen")).toContain('"field":"in","value":"notes"')
    expect(fields("plan -kitchen")).toContain(
      '"occur":"must_not","node":{"kind":"predicate","field":"text","value":"kitchen"',
    )
  })

  it.each([
    ["plan tag:work", "plan"],
    ['"harbour plan" -kitchen date>=30d', "harbour plan"],
    ["date:today", ""],
    ["budg* source:file", ""],
  ])("embeds %s as %j", (query, words) => {
    expect(meaningWords(root(query))).toBe(words)
  })
})
