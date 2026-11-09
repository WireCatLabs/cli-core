import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ModelAdapter, ModelRequest } from "../models/index.js"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
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
    expect(found.harder?.reason).toContain("models search-consents set anthropic --yes")
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
})
