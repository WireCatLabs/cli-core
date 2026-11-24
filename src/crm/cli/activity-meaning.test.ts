import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { provide } from "../../cli/context.js"
import type { CrmActivity } from "../../domain/crm.js"
import { CRM_OPENS } from "../../domain/providers.js"
import type { TextModel } from "../../embeddings/models.js"
import { embedCrmActivities } from "../../services/crm-meaning.js"
import { searchAll } from "../../services/search-all.js"
import { openCache } from "../../store/open.js"
import { crmSettingKey, saveCrmSetting } from "../../store/sqlite/crm-settings.js"
import { openSqlite } from "../../store/sqlite/open.js"
import { type MessageStore, openStore } from "../../store/store.js"
import { exampleDeal, fakeCrmSource } from "../testing/index.js"
import { addCrmCommands } from "./index.js"
import { syncEmbeddings } from "./sync-embed.js"

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

vi.mock("../../embeddings/models.js", async (original) => {
  const real = await original<typeof import("../../embeddings/models.js")>()
  return { ...real, textModel: (id: string) => (id === "e5-small" ? tiny : real.textModel(id)), meaningFloor: () => 0 }
})

const ME = { provider: "telegram", account: "100" }
const PORTAL = { provider: "example-crm", account: "portal" }
const OTHER = { provider: "example-crm", account: "other" }
const NOW = Date.UTC(2026, 10, 24)
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
    fileURLToPath(new URL("../../embeddings/fixtures/tiny", import.meta.url)),
    join(models, "models", "text", "e5-small"),
  )
}

const activity = (externalId: string, body: string | null, on: CrmActivity["on"]): CrmActivity => ({
  externalId,
  kind: "comment",
  subject: "",
  body,
  done: true,
  createdAt: NOW,
  updatedAt: NOW,
  on,
})

// The fixture model reads six words only: cat and kitten are near, zebra and fish far from both.
const crmStore = async (path = join(mkdtempSync(join(tmpdir(), "crm-meaning-")), "store.db")) => {
  const store = await openStore({ path })
  opened.push(store)
  for (const account of [PORTAL, OTHER]) {
    await store.crm.savePipelines(account, "deal", [
      { externalId: "p1", name: "Sales", stages: [{ externalId: "s1", name: "New", position: 1, outcome: "open" }] },
    ])
    await store.crm.savePeople(account, [{ externalId: "c1", name: "Example Person" }])
  }
  const deal = (externalId: string, title: string, assignee: string) => ({
    externalId,
    title,
    pipeline: "p1",
    stage: "s1",
    assignee,
    updatedAt: NOW,
  })
  await store.crm.saveItems(PORTAL, "deal", [deal("d1", "Alpha website", "7"), deal("d2", "Beta website", "9")])
  await store.crm.saveItems(OTHER, "deal", [deal("o1", "Gamma website", "7")])
  await store.crm.saveActivities(PORTAL, [
    activity("a1", "cat cat cat cat cat", [{ kind: "deal", externalId: "d1" }]),
    activity("a2", "zebra zebra zebra zebra", [{ kind: "deal", externalId: "d2" }]),
    // On a contact alone: no deal or lead to name, so meaning never finds it.
    activity("a3", "kitten kitten kitten kitten", [{ kind: "person", externalId: "c1" }]),
    { ...activity("a4", null, [{ kind: "deal", externalId: "d2" }]), kind: "task", subject: "Call" },
    activity("a5", "fish fish fish fish", [
      { kind: "deal", externalId: "d1" },
      { kind: "deal", externalId: "d2" },
    ]),
  ])
  await store.crm.saveActivities(OTHER, [activity("b1", "cat cat cat cat cat", [{ kind: "deal", externalId: "o1" }])])
  const refs = Object.fromEntries(
    [...(await store.deals.list({ account: PORTAL })).items, ...(await store.deals.list({ account: OTHER })).items].map(
      (one) => [one.externalId as string, one.ref],
    ),
  )
  return { store, refs }
}

const crm = (store: MessageStore, text: string, extra: Partial<Parameters<typeof searchAll>[2]> = {}) =>
  searchAll(store, ME, { text, limit: 10, only: ["crm"], ...extra })

describe("deals and leads by the meaning of their activities", () => {
  it("finds a deal by a note saying it in other words, with the note in the hit", async () => {
    download()
    const { store, refs } = await crmStore()
    // a1 and b1 share one text, so one vector; the task's bare "Call" is too short to embed.
    expect(await embedCrmActivities(store, { threads: 1 })).toEqual({ model: "e5-small", embedded: 4, left: false })

    const found = await crm(store, "kitten", { scope: { crm: [PORTAL] } })
    expect(found.crm).toEqual({ by: "words and meaning" })
    expect(found.items).toEqual([
      expect.objectContaining({
        kind: "deal",
        ref: refs.d1,
        provider: "example-crm",
        account: "portal",
        title: "Alpha website",
        foundBy: ["meaning"],
        text: expect.stringContaining("cat cat"),
      }),
    ])
  })

  it("shows a deal found by words and by meaning once, and reads every account unless scoped", async () => {
    download()
    const { store, refs } = await crmStore()
    await embedCrmActivities(store, { threads: 1 })
    const found = await crm(store, "cat")
    expect(found.items.map(({ ref, foundBy }) => [ref, foundBy]).sort()).toEqual(
      [
        [refs.d1, ["words", "meaning"]],
        [refs.o1, ["words", "meaning"]],
      ].sort(),
    )
    const scoped = await crm(store, "kitten", { scope: { crm: [OTHER] } })
    expect(scoped.items.map(({ ref }) => ref)).toEqual([refs.o1])
  })

  it("never finds or names a deal the profile may not read", async () => {
    download()
    const { store, refs } = await crmStore()
    await embedCrmActivities(store, { threads: 1 })
    const viewer = { account: PORTAL, assignee: "portal/user/9" }
    const scope = { crm: [PORTAL] }
    expect((await crm(store, "kitten", { crmViewers: [viewer], scope })).items).toEqual([])
    // One note on both deals: only the profile's own is named.
    expect((await crm(store, "fish", { crmViewers: [viewer], scope })).items.map(({ ref }) => ref)).toEqual([refs.d2])
    const none = { account: PORTAL, assignee: null }
    expect((await crm(store, "fish", { crmViewers: [none], scope })).items).toEqual([])
    expect((await crm(store, "fish", { crmKinds: ["lead"], scope })).items).toEqual([])
  })

  it("forgets an activity that left the copy", async () => {
    download()
    const { store } = await crmStore()
    await embedCrmActivities(store, { threads: 1 })
    await store.crm.saveActivities(PORTAL, [activity("a1", "cat cat cat cat cat", [{ kind: "deal", externalId: "x" }])])
    expect((await crm(store, "kitten", { scope: { crm: [PORTAL] } })).items).toEqual([])
  })

  it("follows an edited note to its new text", async () => {
    download()
    const { store, refs } = await crmStore()
    await embedCrmActivities(store, { threads: 1 })
    await store.crm.saveActivities(PORTAL, [
      activity("a2", "kitten kitten kitten", [{ kind: "deal", externalId: "d2" }]),
    ])
    expect(await embedCrmActivities(store, { threads: 1 })).toMatchObject({ embedded: 1, left: false })
    const found = await crm(store, "cat", { scope: { crm: [PORTAL] } })
    expect(found.items.find(({ ref }) => ref === refs.d2)?.foundBy).toEqual(["meaning"])
  })

  it("searches words only with --exact, a title, no vectors or activities denied, and says why", async () => {
    download()
    const { store } = await crmStore()
    expect((await crm(store, "kitten")).crm).toEqual({
      by: "words",
      meaningSkipped: "no CRM activity has vectors of e5-small yet, so only words were matched",
      needsVectors: true,
    })
    await embedCrmActivities(store, { threads: 1 })
    expect((await crm(store, "kitten", { exact: true })).crm).toEqual({
      by: "words",
      meaningSkipped: "--exact searches words as written",
    })
    expect((await crm(store, "title:kitten")).crm?.meaningSkipped).toBe(
      "the query names a title, which meaning cannot follow",
    )
    const denied = await crm(store, "kitten", { crmActivities: false })
    expect(denied.crm).toEqual({ by: "words", meaningSkipped: "the profile may not read activities" })
    expect(denied.items).toEqual([])
  })

  it("stops embedding before the deadline and says how many chunks are left", async () => {
    download()
    const { store } = await crmStore()
    const deadline = { endsAt: Date.now() + 1_000, ms: 45_000 }
    expect(await embedCrmActivities(store, { threads: 1, deadline })).toEqual({
      model: "e5-small",
      embedded: 0,
      left: true,
      stopped: "deadline",
      remaining: 4,
    })
  })

  it("embeds the activities stored before they had chunks, and says some are left when time ran out", async () => {
    download()
    const path = join(mkdtempSync(join(tmpdir(), "crm-meaning-")), "store.db")
    const { store } = await crmStore(path)
    const { database } = await openSqlite(path)
    database.exec("DELETE FROM chunks WHERE chunkable_type = 'crm_activity'")
    database.close()
    const deadline = { endsAt: Date.now() + 1_000, ms: 45_000 }
    expect(await embedCrmActivities(store, { threads: 1, deadline })).toMatchObject({ embedded: 0, left: true })
    expect(await embedCrmActivities(store, { threads: 1 })).toMatchObject({ embedded: 4, left: false })
  })
})

describe("the CRM's sync --embed", () => {
  const APP = { command: "crm", appName: "crm-meaning", envPrefix: "CRM", description: "", version: "1" }

  const cliOf = async ({ activities = true }: { activities?: boolean } = {}) => {
    const path = join(mkdtempSync(join(tmpdir(), "crm-meaning-cli-")), "store.db")
    const store = await openStore({ path })
    opened.push(store)
    await store.accounts.registerProvider({
      name: "example-crm",
      kind: "crm",
      aliases: [],
      command: "crm",
      opens: CRM_OPENS,
    })
    const database = await openCache(path)
    if (activities) saveCrmSetting(database, crmSettingKey(PORTAL, "activities"), "on", NOW)
    database.close()
    const source = fakeCrmSource({
      activities: [activity("a1", "cat cat cat cat cat", [{ kind: "deal", externalId: "d1" }])],
    })
    source.put("deal", exampleDeal("d1"))
    const run = { profile: "work", account: PORTAL, user: null, store, source: () => source }
    return async (...args: string[]) => {
      let data = ""
      const root = new Command("crm").exitOverride().option("--json").option("--timeout <duration>")
      addCrmCommands(root, { app: APP, open: async () => run, now: () => NOW })
      provide(root, {
        streams: { data: (text: string) => (data += text), diagnostic: () => {} },
      } as never)
      await root.parseAsync([...args, "--json"], { from: "user" })
      return JSON.parse(data) as {
        item: Record<string, unknown>
        items: Record<string, unknown>[]
        missing?: { field: string; why: string }[]
        meta?: { complete?: boolean; issues?: unknown[] }
        next?: { step: string; args: Record<string, unknown> }[]
      }
    }
  }

  it("keeps the sync's report when no model is downloaded, naming it in meta.issues", async () => {
    const cli = await cliOf()
    const done = await cli("sync", "--embed")
    expect(done.item).toMatchObject({ state: "complete" })
    expect(done.item.embeddings).toBeUndefined()
    expect(done.meta).toMatchObject({
      complete: false,
      issues: [{ code: "not_found", reason: "model.not-downloaded", source: "crm:embeddings" }],
    })
  })

  it("says search all found by words only and how to build the vectors, then finds by meaning once built", async () => {
    download()
    const cli = await cliOf()
    await cli("sync")
    const before = await cli("search", "all", "kitten", "--only", "crm")
    expect(before.items).toEqual([])
    expect(before.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "found_by", why: expect.stringContaining("sync --embed") }),
      ]),
    )
    const synced = await cli("sync", "--embed")
    expect(synced.item.embeddings).toEqual({ model: "e5-small", embedded: 1, left: false })
    const after = await cli("search", "all", "kitten", "--only", "crm")
    expect(after.items).toEqual([
      expect.objectContaining({ kind: "deal", title: "Example deal d1", found_by: ["meaning"] }),
    ])
    expect(after.missing ?? []).toEqual([])
  })

  it("names the activities setting first when it is off, since sync --embed then has nothing to embed", async () => {
    download()
    const cli = await cliOf({ activities: false })
    await cli("sync")
    const found = await cli("search", "all", "kitten", "--only", "crm")
    expect(found.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ why: expect.stringMatching(/config set activities on`, then `.*sync --embed`/) }),
      ]),
    )
  })

  it("offers to embed the rest when a run stops before every activity has its vector", async () => {
    download()
    const { store } = await crmStore()
    const command = new Command("sync")
    provide(command, { deadline: () => ({ endsAt: Date.now() + 1_000, ms: 45_000 }) } as never)
    const embedded = await syncEmbeddings(command, store, {}, APP, { max_pages: 5 })
    expect(embedded.item.embeddings).toMatchObject({ embedded: 0, left: true, remaining: 4 })
    expect(embedded.next).toEqual([
      expect.objectContaining({ step: "crm.sync", args: { max_pages: 5, embed: true }, safe_to_auto_execute: true }),
    ])
  })
})
