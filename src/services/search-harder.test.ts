import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ModelAdapter, ModelRequest } from "../models/index.js"
import { writeSharedSection } from "../store/shared-config.js"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
import { enrichmentSettingPath } from "./enrichment-setting.js"
import { searchAll } from "./search-all.js"
import { type HarderOptions, writeHarderSetting } from "./search-harder.js"

const MAIL: AccountKey = { provider: "email", account: "owner@example.com" }
const NOW = Date.parse("2026-11-09T12:00:00Z")
const live: MessageStore[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const store of live.splice(0)) await store.close()
})

const BODIES = [
  "Deposit, deposit, deposit: the retreat deposit is paid.",
  "The deposit receipt, deposit attached.",
  "The deposit for the flat is due on Friday.",
]

const seeded = async () => {
  const root = mkdtempSync(join(tmpdir(), "search-harder-"))
  const env: NodeJS.ProcessEnv = { WIRECAT_STATE_DIR: root, MESSAGING_STORE: join(root, "store.db") }
  const store = await openStore({ env })
  live.push(store)
  const accountId = await store.accounts.saveAccount(MAIL, { name: null })
  for (const [n, body] of BODIES.entries())
    await store.mail.saveThread({
      accountId,
      externalId: `thread-${n}`,
      now: NOW,
      emails: [
        {
          externalId: `<${n}@example.com>`,
          subject: `Update ${n}`,
          from: { address: "team@example.com", name: "Team" },
          to: [{ address: "owner@example.com", name: null }],
          sentAt: NOW - n * 86_400_000,
          receivedAt: NOW - n * 86_400_000,
          bodyText: body,
        },
      ],
    })
  return { env, store }
}

const consent = (env: NodeJS.ProcessEnv) =>
  writeHarderSetting(env, {
    provider: "anthropic",
    model: "claude-haiku-5-5",
    consented_at: "2026-11-09T10:00:00.000Z",
  })

/** Answers with `reply`, or throws it, and keeps every request it got. */
const fakeModel = (reply: string | Error, wait?: (fetcher: typeof fetch) => Promise<unknown>) => {
  const requests: ModelRequest[] = []
  const adapter: ModelAdapter = {
    baseUrl: "https://api.anthropic.com",
    validate: (options) => options,
    complete: async (_target, request, _options, _key, fetcher) => {
      requests.push(request)
      if (wait) await wait(fetcher)
      if (reply instanceof Error) throw reply
      return { text: reply, tokens: 1_000, usage: { input: 900, output: 100 } }
    },
  }
  return { requests, harder: { adapters: { anthropic: adapter }, key: () => "test-key" } satisfies HarderOptions }
}

const search = (store: MessageStore, env: NodeJS.ProcessEnv, harder?: HarderOptions, offset?: number) =>
  searchAll(store, MAIL, {
    text: "deposit",
    limit: 3,
    only: ["mail"],
    now: NOW,
    env,
    ...(offset === undefined ? {} : { offset }),
    ...(harder ? { harder } : {}),
  })

const titles = (found: Awaited<ReturnType<typeof search>>) => found.items.map(({ title }) => title)

describe("search all --harder", () => {
  it("**off sends nothing**, even with the consent and a key in place", async () => {
    const { env, store } = await seeded()
    consent(env)
    const sent = vi.spyOn(globalThis, "fetch")
    const found = await search(store, { ...env, ANTHROPIC_API_KEY: "test-key" })
    expect(found.harder).toBeUndefined()
    expect(sent).not.toHaveBeenCalled()
  })

  it("**without the owner's consent sends nothing** and gives the plain order with the reason", async () => {
    const { env, store } = await seeded()
    const plain = titles(await search(store, env))
    const model = fakeModel('{"records":[2]}')
    const found = await search(store, env, model.harder)
    expect(model.requests).toEqual([])
    expect(titles(found)).toEqual(plain)
    expect(found.harder).toMatchObject({ applied: false, sent: 0, reason_id: "harder.no-consent" })
    expect(found.harder?.reason).toContain("models search-consents set <provider> --yes")
  })

  it("**a broken consent setting keeps the plain order** and names the file, never failing the search", async () => {
    const { env, store } = await seeded()
    writeSharedSection(enrichmentSettingPath(env), "search_harder", { provider: "mistral" })
    const model = fakeModel('{"records":[2]}')
    const found = await search(store, env, model.harder)
    expect(model.requests).toEqual([])
    expect(found.items).toHaveLength(3)
    expect(found.harder).toMatchObject({ applied: false, sent: 0, reason_id: "harder.bad-setting" })
    expect(found.harder?.reason).toContain("search_harder.provider is invalid")
  })

  it("**without a key sends nothing**", async () => {
    const { env, store } = await seeded()
    consent(env)
    const model = fakeModel('{"records":[2]}')
    const found = await search(store, env, { adapters: model.harder.adapters })
    expect(model.requests).toEqual([])
    expect(found.harder).toMatchObject({ applied: false, reason_id: "harder.no-key" })
  })

  it("**on, puts the hits the model names first**, the rest after in their plain order", async () => {
    const { env, store } = await seeded()
    consent(env)
    const [first, second, third] = titles(await search(store, env))
    const model = fakeModel('{"records":[2, 7, 2]}')
    const found = await search(store, env, model.harder)
    expect(titles(found)).toEqual([third, first, second])
    expect(found.harder).toMatchObject({ applied: true, sent: 3, model: "claude-haiku-5-5", cost_usd: 0.00014 })
    const [request] = model.requests
    expect(request?.prompt).toContain("Today is 2026-11-09")
    expect(request?.prompt).toContain("Question: deposit")
    expect(request?.data).toContain(`[2] (2026-11-07) ${third}`)
    expect(request?.options).toMatchObject({ thinking: { type: "disabled" }, output_config: { effort: "low" } })
  })

  it.each([
    ["an error", fakeModel(new Error("overloaded")), "harder.error"],
    ["an answer that is not the list", fakeModel("the third one"), "harder.bad-reply"],
  ])("**%s from the model keeps the plain order**", async (_name, model, reason) => {
    const { env, store } = await seeded()
    consent(env)
    const plain = titles(await search(store, env))
    const found = await search(store, env, model.harder)
    expect(titles(found)).toEqual(plain)
    expect(found.harder).toMatchObject({ applied: false, sent: 3, reason_id: reason })
  })

  it("**a model that does not answer in time keeps the plain order**", async () => {
    const { env, store } = await seeded()
    consent(env)
    const plain = titles(await search(store, env))
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))
    const model = fakeModel('{"records":[2]}', (fetcher) => fetcher("https://api.anthropic.com/v1/messages", {}))
    const found = await search(store, env, { ...model.harder, fetch: hanging, timeoutMs: 5 })
    expect(titles(found)).toEqual(plain)
    expect(found.harder).toMatchObject({ applied: false, reason_id: "harder.timeout" })
  })

  it("**a later page is not reordered and sends nothing**", async () => {
    const { env, store } = await seeded()
    consent(env)
    const model = fakeModel('{"records":[2]}')
    const found = await search(store, env, model.harder, 1)
    expect(model.requests).toEqual([])
    expect(found.harder).toMatchObject({ applied: false, reason_id: "harder.later-page" })
  })

  describe("with a question, the model rewrites it first", () => {
    const QUESTION = "what is due for the flat deposit?"
    const REWRITES = "1. Which deposit for the flat is due?\n2. The flat deposit is due\n3. bond apartment flat 2026-11"

    /** The rewrite and the rerank answer apart; "hang" waits until the call's own time limit. */
    const twoCalls = (answers: { rewrite: string | Error | "hang"; rerank: string }) => {
      const requests: ModelRequest[] = []
      const adapter: ModelAdapter = {
        baseUrl: "https://api.anthropic.com",
        validate: (options) => options,
        complete: async (_target, request, _options, _key, fetcher) => {
          requests.push(request)
          const reply = request.purpose === "search-harder-rewrite" ? answers.rewrite : answers.rerank
          if (reply === "hang") await fetcher("https://api.anthropic.com/v1/messages", {})
          if (reply instanceof Error) throw reply
          return { text: reply as string, tokens: 1_000, usage: { input: 900, output: 100 } }
        },
      }
      const hanging: typeof fetch = (_input, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))
      return {
        requests,
        harder: { adapters: { anthropic: adapter }, key: () => "test-key", fetch: hanging, timeoutMs: 50 },
      }
    }

    const withBond = async () => {
      const seededStore = await seeded()
      const [accountId] = (await seededStore.store.accounts.storedAccounts()).map(({ id }) => Number(id))
      await seededStore.store.mail.saveThread({
        accountId: accountId as number,
        externalId: "thread-bond",
        now: NOW,
        emails: [
          {
            externalId: "<bond@example.com>",
            subject: "Apartment bond",
            from: { address: "landlord@example.com", name: "Landlord" },
            to: [{ address: "owner@example.com", name: null }],
            sentAt: NOW - 5 * 86_400_000,
            receivedAt: NOW - 5 * 86_400_000,
            bodyText: "The bond for the apartment: please pay it by Friday.",
          },
        ],
      })
      return seededStore
    }

    const ask = (store: MessageStore, env: NodeJS.ProcessEnv, harder?: HarderOptions) =>
      searchAll(store, MAIL, {
        text: QUESTION,
        limit: 10,
        only: ["mail"],
        now: NOW,
        env,
        ...(harder ? { harder } : {}),
      })

    it("**finds what only a rewrite's words find**, sends the question alone, then reranks", async () => {
      const { env, store } = await withBond()
      consent(env)
      expect(titles(await ask(store, env))).not.toContain("Apartment bond")
      const model = twoCalls({ rewrite: REWRITES, rerank: '{"records":[]}' })
      const found = await ask(store, env, model.harder)
      expect(titles(found)).toContain("Apartment bond")
      const [rewrite, rerank] = model.requests
      expect(rewrite?.purpose).toBe("search-harder-rewrite")
      expect(rewrite?.prompt).toContain(`Question: ${QUESTION}`)
      expect(rewrite?.prompt).toContain("Today is 2026-11-09")
      expect(rewrite?.data).toBeUndefined()
      expect(rerank?.data).toContain("Apartment bond")
      expect(found.harder).toMatchObject({
        applied: true,
        cost_usd: 0.00028,
        rewrite: { applied: true, texts: 3, cost_usd: 0.00014 },
      })
    })

    it.each([
      ["does not answer in time", "hang" as const, "harder.timeout"],
      ["fails", new Error("overloaded"), "harder.error"],
      ["answers in another shape", "Which deposit is due?", "harder.bad-reply"],
    ])("**a rewrite that %s searches the question alone** and still reranks", async (_name, rewrite, reason) => {
      const { env, store } = await withBond()
      consent(env)
      const plain = titles(await ask(store, env))
      const model = twoCalls({ rewrite, rerank: '{"records":[]}' })
      const found = await ask(store, env, model.harder)
      expect(titles(found)).toEqual(plain)
      expect(found.harder).toMatchObject({ applied: true, rewrite: { applied: false, texts: 0, reason_id: reason } })
    })

    it("**without the owner's consent neither call is made**", async () => {
      const { env, store } = await withBond()
      const model = twoCalls({ rewrite: REWRITES, rerank: '{"records":[]}' })
      const found = await ask(store, env, model.harder)
      expect(model.requests).toEqual([])
      expect(found.harder).toMatchObject({ applied: false, reason_id: "harder.no-consent" })
      expect(found.harder?.rewrite).toBeUndefined()
    })

    it("**words that are no question are not rewritten**; the rerank runs alone", async () => {
      const { env, store } = await seeded()
      consent(env)
      const model = twoCalls({ rewrite: REWRITES, rerank: '{"records":[]}' })
      const found = await search(store, env, model.harder)
      expect(model.requests.map(({ purpose }) => purpose)).toEqual(["search-harder"])
      expect(found.harder?.rewrite).toMatchObject({ applied: false, reason_id: "harder.not-a-question" })
    })
  })

  describe("with another provider", () => {
    /** An OpenAI-shaped adapter: the gateway checks its options as it would the real one's. */
    const openaiModel = (reply: string) => {
      const requests: { request: ModelRequest; options: unknown; baseUrl: string }[] = []
      const adapter: ModelAdapter = {
        baseUrl: "https://api.openai.com/v1",
        validate: (options) => {
          if (options && ("thinking" in options || "output_config" in options)) throw new Error("not an OpenAI option")
          return options
        },
        complete: async (target, request, options) => {
          requests.push({ request, options, baseUrl: target.baseUrl })
          return { text: reply, tokens: 1_000, usage: { input: 900, output: 100 } }
        },
      }
      return { requests, harder: { adapters: { openai: adapter }, key: () => "test-key" } satisfies HarderOptions }
    }

    it("**OpenAI gets its own JSON option and the shape in the prompt**, and a fenced answer is still read", async () => {
      const { env, store } = await seeded()
      writeHarderSetting(env, { provider: "openai", model: "gpt-4o-mini", consented_at: "2026-11-09T10:00:00.000Z" })
      const [first, second, third] = titles(await search(store, env))
      const model = openaiModel('```json\n{"records": [2]}\n```')
      const found = await search(store, env, model.harder)
      expect(titles(found)).toEqual([third, first, second])
      const [call] = model.requests
      expect(call?.options).toEqual({ temperature: 0, response_format: { type: "json_object" } })
      expect(call?.request.prompt).toContain('{"records": [numbers]}')
      expect(found.harder).toMatchObject({
        applied: true,
        provider: "openai",
        model: "gpt-4o-mini",
        endpoint: "https://api.openai.com/v1",
        cost_usd: 0.000195,
      })
    })

    it("**an OpenAI-compatible API gets no options** and its unknown price is null", async () => {
      const { env, store } = await seeded()
      writeHarderSetting(env, {
        provider: "openai",
        model: "deepseek/deepseek-chat",
        base_url: "https://openrouter.ai/api/v1",
        consented_at: "2026-11-09T10:00:00.000Z",
      })
      const model = openaiModel('{"records": [2]}')
      const found = await search(store, env, model.harder)
      expect(model.requests[0]).toMatchObject({ options: {}, baseUrl: "https://openrouter.ai/api/v1" })
      expect(found.harder).toMatchObject({
        applied: true,
        model: "deepseek/deepseek-chat",
        endpoint: "https://openrouter.ai/api/v1",
        cost_usd: null,
      })
    })
  })
})
