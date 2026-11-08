import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { memoryKeyring } from "@wirecat/cli-base"
import { afterEach, describe, expect, it } from "vitest"
import { textModelsFile } from "../embeddings/models.js"
import type { ModelAdapter, ModelRequest } from "../models/index.js"
import { writeSharedSection } from "../store/shared-config.js"
import { type MessageStore, openStore } from "../store/store.js"
import { enrichmentState, enrichRecords, parseEnrichmentReply } from "./enrichment.js"
import { readEnrichmentSetting, writeEnrichmentSetting } from "./enrichment-setting.js"
import { embedMail, embedNotes, localModel, nearestNotes, searchNotesQuery, withLocal } from "./notes-search.js"

const fixture = fileURLToPath(new URL("../embeddings/fixtures/tiny", import.meta.url))
const pinned = (name: string) => {
  const bytes = readFileSync(join(fixture, name))
  return {
    name,
    url: `https://example.test/${name}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  }
}

const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})

/** A store with a downloaded five-word model in use, and the shared settings file beside it. */
const machine = async () => {
  const root = mkdtempSync(join(tmpdir(), "enrichment-"))
  const env: NodeJS.ProcessEnv = { WIRECAT_STATE_DIR: root, MESSAGING_STORE: join(root, "store.db") }
  mkdirSync(join(root, "models", "text"), { recursive: true })
  symlinkSync(fixture, join(root, "models", "text", "tiny"))
  const tiny = {
    id: "tiny",
    title: "a five-word model",
    languages: "test",
    licence: "none",
    dims: 4,
    maxTokens: 64,
    pooling: "mean" as const,
    prefix: { query: "", passage: "" },
    onnx: "onnx/model.onnx",
    files: ["onnx/model.onnx", "tokenizer.json", "tokenizer_config.json"].map(pinned),
  }
  writeSharedSection(textModelsFile(env), "text_models", { custom: [tiny], use: "tiny" })
  const store = await openStore({ env })
  live.push(store)
  return { env, store }
}

const turnOn = (env: NodeJS.ProcessEnv) =>
  writeEnrichmentSetting(env, { provider: "openai", model: "gpt-4o-mini", consented_at: "2026-11-08T10:00:00.000Z" })

/** Answers every record with what `write` gives its text, and keeps each request it got. */
const fakeModel = (write: (text: string) => { facts: string[]; questions: string[] }) => {
  const requests: ModelRequest[] = []
  const adapter: ModelAdapter = {
    baseUrl: "https://api.openai.com/v1",
    validate: (options) => options,
    complete: async (_target, request) => {
      requests.push(request)
      const records = JSON.parse(request.data ?? "[]") as { i: number; text: string }[]
      return {
        text: JSON.stringify({ records: records.map(({ i, text }) => ({ i, ...write(text) })) }),
        tokens: 100,
        usage: { input: 60, output: 40 },
      }
    },
  }
  return { requests, adapters: { openai: adapter } }
}

describe("enrichment", () => {
  it("is off by default: no request, no key read", async () => {
    const { env, store } = await machine()
    await store.notes.addNote({ text: "cat dog" })
    const model = fakeModel(() => ({ facts: ["zebra"], questions: [] }))
    const key = () => {
      throw new Error("a key was read")
    }

    expect(await enrichRecords(store, { env, ...model, key })).toEqual({ status: "off" })
    expect(model.requests).toEqual([])
    expect(readEnrichmentSetting(env)).toBeUndefined()
  })

  it("sends each record once, as untrusted data, and pays again only when its text changes", async () => {
    const { env, store } = await machine()
    turnOn(env)
    const note = await store.notes.addNote({ text: "cat dog" })
    const model = fakeModel(() => ({ facts: ["zebra kitten"], questions: ["which zebra?"] }))

    const first = await enrichRecords(store, { env, ...model, key: () => "test-key" })
    const again = await enrichRecords(store, { env, ...model, key: () => "test-key" })

    expect(first).toMatchObject({ status: "done", enriched: 1, failed: 0, left: 0, usage: { input: 60, output: 40 } })
    expect(first.status === "done" && first.cost_usd).toBeCloseTo(60 * 0.15e-6 + 40 * 0.6e-6, 8)
    expect(again).toMatchObject({ enriched: 0, left: 0 })
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]?.data).toContain("cat dog")
    expect(model.requests[0]?.prompt).not.toContain("cat dog")
    expect(model.requests[0]?.allowSourceQuotes).toBe(true)

    await store.notes.editNote(note.ref, "cat dog fish", note.revision)
    expect(await enrichRecords(store, { env, ...model, key: () => "test-key" })).toMatchObject({ enriched: 1 })
    expect(model.requests).toHaveLength(2)
  })

  it("finds a record by the model's words, cites the record, and keeps --exact to the record's own words", async () => {
    const { env, store } = await machine()
    turnOn(env)
    const note = await store.notes.addNote({ text: "cat dog" })
    await store.notes.addNote({ text: "fish" })
    const model = fakeModel((text) =>
      text.includes("cat") ? { facts: ["zebra kitten"], questions: [] } : { facts: [], questions: [] },
    )
    await enrichRecords(store, { env, ...model, key: () => "test-key" })

    const byStems = await searchNotesQuery(store, { text: "zebra", limit: 5 })
    const exact = await searchNotesQuery(store, { text: "zebra", limit: 5, exact: true })

    expect(byStems.items.map((hit) => hit.note.ref)).toEqual([note.ref])
    expect(exact.items).toEqual([])
  })

  it("embeds the model's text as a chunk of its own, so search by meaning finds the record by it", async () => {
    const { env, store } = await machine()
    turnOn(env)
    await store.notes.addNote({ text: "cat dog" })
    const zebra = await store.notes.addNote({ text: "zebra" })
    const model = fakeModel((text) =>
      text === "zebra" ? { facts: ["fish fish"], questions: [] } : { facts: [], questions: [] },
    )

    expect(await embedNotes(store, { env, threads: 1, enrichWith: { ...model, key: () => "test-key" } })).toMatchObject(
      {
        embedded: 3,
        enrichment: { status: "done", enriched: 2 },
      },
    )
    const [best] = await nearestNotes(store, "fish", { env, limit: 1, threads: 1 })

    expect(best?.ref).toBe(zebra.ref)
  })

  it("enriches mail at sync before embedding, and search by meaning cites the email", async () => {
    const { env, store } = await machine()
    turnOn(env)
    const accountId = await store.accounts.saveAccount(
      { provider: "email", account: "owner@example.com" },
      { name: null },
    )
    const email = (externalId: string, bodyText: string, day: number) => ({
      externalId,
      subject: null,
      from: null,
      to: [],
      sentAt: Date.UTC(2026, 0, day),
      bodyText,
    })
    await store.mail.saveThread({
      accountId,
      externalId: "thread-1",
      now: Date.UTC(2026, 0, 10),
      emails: [email("<one@example.com>", "zebra", 5), email("<two@example.com>", "cat dog", 6)],
    })
    const model = fakeModel((text) =>
      text.includes("zebra") ? { facts: ["fish fish"], questions: [] } : { facts: [], questions: [] },
    )

    const run = await embedMail(store, { env, threads: 1, enrichWith: { ...model, key: () => "test-key" } })
    const { model: chosen, directory, key } = localModel(undefined, env, undefined)
    const [query] = await withLocal(chosen, directory, 1, (embedder) => embedder.embed(["fish"], "query"))
    const [best] = await store.mail.nearest(key, query as Float32Array, { accountId, limit: 1 })

    expect(run).toMatchObject({ embedded: 3, left: false, enrichment: { status: "done", enriched: 2 } })
    expect(model.requests).toHaveLength(1)
    expect(best?.externalId).toBe("<one@example.com>")
  })

  it("turning it off deletes every enrichment and the record is searched by its own text again", async () => {
    const { env, store } = await machine()
    turnOn(env)
    await store.notes.addNote({ text: "cat dog" })
    await enrichRecords(store, {
      env,
      ...fakeModel(() => ({ facts: ["zebra"], questions: [] })),
      key: () => "test-key",
    })
    expect((await searchNotesQuery(store, { text: "zebra", limit: 5 })).items).toHaveLength(1)

    writeEnrichmentSetting(env, undefined)
    expect(await store.enrichment?.clear()).toBe(1)

    expect((await searchNotesQuery(store, { text: "zebra", limit: 5 })).items).toEqual([])
    expect(await enrichmentState(store, env)).toMatchObject({ on: false, records: 1, enriched: 0, pending: 1 })
  })

  it("estimates the pending records' cost with the chosen model's price", async () => {
    const { env, store } = await machine()
    await store.notes.addNote({ text: "x".repeat(400) })

    const state = await enrichmentState(store, env, { provider: "openai", model: "gpt-4o-mini" })
    const unknown = await enrichmentState(store, env, { provider: "openai", model: "my-model" })

    expect(state.estimate).toMatchObject({ records: 1, input_tokens: 140, output_tokens: 70 })
    expect(state.estimate.usd).toBeGreaterThan(0)
    expect(unknown.estimate.usd).toBeNull()
  })

  it("reads the tool's keyring entry named after the provider", async () => {
    const { env, store } = await machine()
    writeEnrichmentSetting(env, {
      provider: "anthropic",
      model: "claude-haiku-5-5",
      consented_at: "2026-11-08T10:00:00.000Z",
    })
    await store.notes.addNote({ text: "cat" })
    const seen: (string | undefined)[] = []
    const adapter: ModelAdapter = {
      baseUrl: "https://api.anthropic.com",
      validate: (options) => options,
      complete: async (_target, request, _options, apiKey) => {
        seen.push(apiKey)
        return { text: JSON.stringify({ records: [{ i: 0, facts: ["zebra"], questions: [] }] }), tokens: 3 }
      },
    }
    const keyring = memoryKeyring()
    keyring.set("fixture", "anthropic", "test-key")
    const app = { command: "fixture", appName: "fixture", envPrefix: "FIXTURE", description: "", version: "1" }

    const run = await enrichRecords(store, { env, app, keyring, adapters: { anthropic: adapter } })

    expect(run).toMatchObject({ status: "done", enriched: 1 })
    expect(seen).toEqual(["test-key"])
  })

  it("sends nothing without a key for the public API", async () => {
    const { env, store } = await machine()
    turnOn(env)
    await store.notes.addNote({ text: "cat" })
    const model = fakeModel(() => ({ facts: ["zebra"], questions: [] }))

    const run = await enrichRecords(store, { env, ...model, key: () => undefined })

    expect(run).toMatchObject({
      status: "stopped",
      enriched: 0,
      left: 1,
      reason: expect.stringMatching(/OPENAI_API_KEY/),
    })
    expect(model.requests).toEqual([])
  })

  it("stops on a provider error and keeps the records pending", async () => {
    const { env, store } = await machine()
    turnOn(env)
    await store.notes.addNote({ text: "cat" })
    const failing: ModelAdapter = {
      baseUrl: "https://api.openai.com/v1",
      validate: (options) => options,
      complete: async () => ({ text: "not json", tokens: 5 }),
    }

    const run = await enrichRecords(store, { env, adapters: { openai: failing }, key: () => "test-key" })

    expect(run).toMatchObject({ status: "done", enriched: 0, failed: 1, left: 1 })
  })
})

describe("parseEnrichmentReply", () => {
  it("bounds what a record can add to the index", () => {
    const long = "word ".repeat(500)
    const rows = parseEnrichmentReply(
      JSON.stringify({
        records: [{ i: 0, facts: [long, "b", "c", "d", "e", "f", 7], questions: ["q1", "q2", "q3", "q4"] }],
      }),
    )

    const lines = rows.get(0)?.split("\n") ?? []
    expect(lines).toHaveLength(8)
    expect(Math.max(...lines.map((one) => one.length))).toBeLessThanOrEqual(400)
  })

  it("refuses a reply that is not the asked JSON", () => {
    expect(() => parseEnrichmentReply("sure, here you go")).toThrow(/no JSON/)
  })
})
