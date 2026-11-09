import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { runBudget } from "../background/budget.js"
import { openCache } from "../store/open.js"
import { parseCrmSettingValue } from "../store/sqlite/crm-settings.js"
import { type MessageStore, openStore } from "../store/store.js"
import { type CrmSyncOptions, type CrmSyncReport, crmStatus, parseCrmCursor, syncCrm } from "./index.js"
import { exampleDeal, examplePerson, fakeCrmSource } from "./testing/index.js"

const stores: MessageStore[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

const PORTAL = { provider: "example-crm", account: "portal" }

it("store status says which kinds a stopped sync left partial, and how much each holds", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "crm-status-")), "store.db") })
  stores.push(store)
  const source = fakeCrmSource({ traits: { removedInChanges: true } })
  for (const id of ["d1", "d2", "d3"]) source.put("deal", exampleDeal(id))
  const now = Date.now()
  await syncCrm(source, store, PORTAL, { now, budget: runBudget({ requests: 9 }) })
  const { items } = await crmStatus(store, PORTAL, { profile: "work", now })
  expect(items.map(({ kind, state, stored }) => [kind, state, stored])).toEqual([
    ["organization", "complete", 0],
    ["person", "complete", 0],
    ["deal", "partial", 2],
    ["lead", "partial", 0],
  ])
  expect(items[2]).toMatchObject({ round: "full", job: "crm deal", profile: "work" })
})

it("a cursor another build wrote in a shape this one does not know reads as none", () => {
  expect(parseCrmCursor('{"v":2}')).toBeNull()
  expect(parseCrmCursor("not json")).toBeNull()
  expect(parseCrmCursor(null)).toBeNull()
})

it("says on the first sync, and only then, how to add an ungrouped CRM account to a work group", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "crm-hint-")), "store.db") })
  stores.push(store)
  const source = fakeCrmSource()
  source.put("deal", exampleDeal("d1"))
  const first = await syncCrm(source, store, PORTAL)
  expect(first.groupHint).toBe("add it to a work group: `memo groups add work example-crm:portal`")
  expect((await syncCrm(source, store, PORTAL)).groupHint).toBeUndefined()
})

it("gives no work group hint for a CRM account a saved group other than personal lists", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "crm-hint-")), "store.db") })
  stores.push(store)
  await store.accounts.saveAccount(PORTAL, { name: null })
  await store.accounts.saveAccountGroup("sales", ["example-crm:portal"])
  const source = fakeCrmSource()
  source.put("deal", exampleDeal("d1"))
  expect((await syncCrm(source, store, PORTAL)).groupHint).toBeUndefined()
})

it("still hints for a CRM account whose profile is named work but no saved group lists", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "crm-hint-")), "store.db") })
  stores.push(store)
  await store.accounts.saveAccount(PORTAL, { name: null })
  await store.accounts.saveProfile("crm", "work", PORTAL)
  const source = fakeCrmSource()
  source.put("deal", exampleDeal("d1"))
  expect((await syncCrm(source, store, PORTAL)).groupHint).toMatch(/memo groups add work example-crm:portal/)
})

it("still hints for a CRM account when a work group exists without it", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "crm-hint-")), "store.db") })
  stores.push(store)
  await store.accounts.saveAccount(PORTAL, { name: null })
  await store.accounts.saveAccount({ provider: "telegram", account: "102" }, { name: null })
  await store.accounts.saveAccountGroup("work", ["telegram:102"])
  const source = fakeCrmSource()
  source.put("deal", exampleDeal("d1"))
  expect((await syncCrm(source, store, PORTAL)).groupHint).toMatch(/memo groups add work example-crm:portal/)
})

const KEY = `crm.${PORTAL.provider}:${PORTAL.account}`

const scoped = async ({ self = "7", removedInChanges = false } = {}) => {
  const path = join(mkdtempSync(join(tmpdir(), "crm-scope-")), "store.db")
  const store = await openStore({ path })
  stores.push(store)
  let source = fakeCrmSource({ self, traits: { removedInChanges } })
  const raw = async (name: string, value: unknown) => {
    const database = await openCache(path)
    const query =
      value === undefined
        ? database.prepare("DELETE FROM store_settings WHERE key = ?")
        : database.prepare("INSERT OR REPLACE INTO store_settings (key, value, at) VALUES (?, ?, 1)")
    query.run(...([`${KEY}.${name}`, ...(value === undefined ? [] : [JSON.stringify(value)])] as [string]))
    database.close()
  }
  const set = (name: "scope" | "unassigned", value: string) => raw(name, parseCrmSettingValue(name, value))
  const sync = (options: CrmSyncOptions = {}) => syncCrm(source, store, PORTAL, options)
  const deals = async () =>
    (await store.deals.list({ account: PORTAL, kind: "deal" })).map(({ externalId }) => externalId).sort()
  const signIn = (other: string) => {
    const next = fakeCrmSource({ self: other, traits: { removedInChanges } })
    for (const id of ["d1", "d2", "d3"]) next.put("deal", exampleDeal(id, { assignee: other }))
    source = next
  }
  return { store, source: () => source, raw, set, sync, deals, signIn }
}
const dealOf = (report: CrmSyncReport) => report.synced.find(({ kind }) => kind === "deal")

it("copies the own user's, the unassigned users' and nobody's deals by default, and drops one given away", async () => {
  const { source, set, sync, deals } = await scoped()
  source().put("deal", exampleDeal("d1", { assignee: "7" }))
  source().put("deal", exampleDeal("d2", { assignee: "9" }))
  source().put("deal", exampleDeal("d3", { assignee: "15" }))
  source().put("deal", exampleDeal("d4"))
  await set("unassigned", "15")
  expect((await sync()).scope).toEqual({ mode: "mine", self: "7", also: ["15"] })
  expect(await deals()).toEqual(["d1", "d3", "d4"])
  source().put("deal", exampleDeal("d1", { assignee: "9" }))
  expect(dealOf(await sync())).toMatchObject({ round: "changes", outOfScope: 1 })
  expect(await deals()).toEqual(["d3", "d4"])
  source().put("deal", exampleDeal("d1", { assignee: "7" }))
  await sync()
  expect(await deals()).toEqual(["d1", "d3", "d4"])
})

it("copies no deal of an unassigned user the CRM refuses, says so, and narrows once it does", async () => {
  const { source, set, sync, deals } = await scoped()
  source().put("deal", exampleDeal("d1", { assignee: "7" }))
  source().put("deal", exampleDeal("d2", { assignee: "9" }))
  source().put("deal", exampleDeal("d3", { assignee: "15" }))
  await set("scope", "mine")
  await set("unassigned", "9,15")
  let refused: string[] = []
  Object.assign(source(), {
    unassigned: async (users: readonly string[]) => ({
      kept: users.filter((id) => !refused.includes(id)),
      message: "an active employee",
    }),
  })
  expect((await sync()).scope).toEqual({ mode: "mine", self: "7", also: ["9", "15"] })
  expect(await deals()).toEqual(["d1", "d2", "d3"])

  refused = ["9"]
  const report = await sync()
  expect(report.scope).toEqual({ mode: "mine", self: "7", also: ["15"] })
  expect(report.issues).toContainEqual({
    kind: "deal",
    reason: "crm.unassigned-dropped",
    message: `${KEY}.unassigned names user 9, not counted as nobody's: an active employee; their deals and leads are not copied`,
  })
  expect(await deals()).toEqual(["d1", "d3"])
})

it("narrows in the store with no list from the CRM, widens by a full round, and keeps confirmed links", async () => {
  const { store, source, set, sync, deals } = await scoped()
  source().put("person", examplePerson("p1"))
  source().put("deal", exampleDeal("d0", { assignee: "7" }))
  for (let at = 1; at <= 11; at += 1)
    source().put("deal", exampleDeal(`d${at}`, { assignee: "9", people: [{ externalId: "p1", role: "contact" }] }))
  await set("scope", "all")
  await sync()
  expect(await deals()).toHaveLength(12)
  const deal = (await store.crm.refOf(PORTAL, "deal", "d1")) as string
  const [link] = await store.knowledge.relations(null, deal)
  await store.knowledge.confirmRelation(null, link?.id as string, "owner")

  await set("scope", "mine")
  const listed = source().calls.ids
  expect(dealOf(await sync())).toMatchObject({ round: "changes", outOfScope: 11, unlisted: 0 })
  expect(source().calls.ids).toBe(listed)
  expect(await deals()).toEqual(["d0"])

  await set("scope", "all")
  const widened = await sync()
  expect(widened.scope).toEqual({ mode: "all" })
  expect(dealOf(widened)).toMatchObject({ round: "full", saved: 12 })
  expect(await deals()).toHaveLength(12)
  expect(await store.knowledge.relations(null, deal)).toEqual([
    expect.objectContaining({ id: link?.id, standing: "confirmed" }),
  ])
})

it("narrows a CRM that names its deletions in changes the same way", async () => {
  const { source, set, sync, deals, store } = await scoped({ removedInChanges: true })
  source().put("deal", exampleDeal("d1", { assignee: "7" }))
  source().put("deal", exampleDeal("d2", { assignee: "9" }))
  await set("scope", "all")
  await sync()
  await set("scope", "mine")
  await sync()
  expect(await deals()).toEqual(["d1"])
  const { items } = await crmStatus(store, PORTAL, { profile: "work", now: Date.now() })
  expect(items.find(({ kind }) => kind === "deal")?.state).toBe("complete")
})

it("widening runs no id pass, and an empty id list never marks a copy deleted without --rescan", async () => {
  const { source, set, sync, deals } = await scoped()
  for (let at = 1; at <= 5; at += 1) source().put("deal", exampleDeal(`d${at}`, { assignee: "7" }))
  await sync()
  await set("scope", "all")
  source().hideAll(true)
  const listed = source().calls.ids
  await sync()
  expect(source().calls.ids).toBe(listed)
  const held = await sync({ now: Date.now() + 2 * 86_400_000 })
  expect(dealOf(held)).toMatchObject({ pass: "held", unlisted: 0 })
  expect(await deals()).toHaveLength(5)
})

it("takes user ids however the CRM or the owner spells them", async () => {
  const { source, set, sync, deals } = await scoped({ self: "07" })
  source().put("deal", exampleDeal("d1", { assignee: "7" }))
  source().put("deal", exampleDeal("d2", { assignee: "0015" }))
  source().put("deal", exampleDeal("d3", { assignee: "9" }))
  await set("unassigned", "015")
  expect((await sync()).scope).toEqual({ mode: "mine", self: "7", also: ["15"] })
  expect(await deals()).toEqual(["d1", "d2"])
})

it("refuses a sign-in of another user on an account whose copy is one user's, until the owner unsets self", async () => {
  const { raw, sync, deals, signIn } = await scoped()
  await sync()
  signIn("9")
  await expect(sync()).rejects.toMatchObject({ code: "validation_error", details: { setting: `${KEY}.self` } })
  await expect(sync()).rejects.toThrow(/copy is user 7's, and this sign-in is user 9: .*config unset/)
  expect(await deals()).toEqual([])
  await raw("self", undefined)
  await sync()
  expect(await deals()).toEqual(["d1", "d2", "d3"])
})

it("reads no deal or lead under an unassigned value an older build stored, and names the setting to change", async () => {
  const { source, raw, sync } = await scoped()
  source().put("deal", exampleDeal("d1", { assignee: "7" }))
  await raw("unassigned", ["12", "bot"])
  const report = await sync()
  expect(
    report.synced.filter(({ setting }) => setting !== undefined).map(({ kind, setting }) => [kind, setting]),
  ).toEqual([
    ["deal", `${KEY}.unassigned`],
    ["lead", `${KEY}.unassigned`],
  ])
  expect(dealOf(report)?.error).toContain('"bot"')
  expect(source().calls.changes).toBe(2)
})

it("refuses a source whose own user is not a user id, before it claims the copy", async () => {
  for (const self of ["", "bot"]) {
    const { sync, store } = await scoped({ self })
    await expect(sync()).rejects.toMatchObject({ code: "invalid_response" })
    expect(await store.crm.ownUser(PORTAL)).toBeUndefined()
  }
})

it("stores the owner's self as the CRM spells it once normalised", () => {
  expect(parseCrmSettingValue("self", "015")).toBe("15")
  expect(() => parseCrmSettingValue("self", "bot")).toThrow(/numeric user id/)
})

it("holds the default mine's deletions of the stored copy, still reading new pages under mine, until the owner sets it", async () => {
  const { source, set, raw, sync, deals } = await scoped()
  source().put("deal", exampleDeal("d0", { assignee: "7" }))
  for (let at = 1; at <= 3; at += 1) source().put("deal", exampleDeal(`d${at}`, { assignee: "9" }))
  await set("scope", "all")
  await sync()
  await raw("scope", undefined)
  source().put("deal", exampleDeal("d4", { assignee: "9" }))
  source().put("deal", exampleDeal("d5", { assignee: "7" }))
  const held = await sync()
  expect(dealOf(held)).toMatchObject({ held: true, outOfScope: 0 })
  const issue = held.issues.find(({ reason }) => reason === "crm.narrowing-held")
  expect(issue?.message).toMatch(/user 7: 3 of the 4/)
  expect(issue?.message).not.toMatch(/rescan|config set/)
  expect(await deals()).toEqual(["d0", "d1", "d2", "d3", "d5"])

  source().put("deal", exampleDeal("d1", { assignee: "9", title: "changed" }))
  expect(dealOf(await sync({ rescan: true }))).toMatchObject({ held: true })
  expect(await deals()).toEqual(["d0", "d1", "d2", "d3", "d5"])

  await set("scope", "mine")
  const lifted = await sync()
  expect(dealOf(lifted)).toMatchObject({ outOfScope: 3 })
  expect(dealOf(lifted)?.held).toBeUndefined()
  expect(await deals()).toEqual(["d0", "d5"])
})

it("after a held narrowing, scope all lists in full: deals made or given away during the hold arrive", async () => {
  const { source, set, raw, sync, deals, store } = await scoped()
  source().put("deal", exampleDeal("d0", { assignee: "7" }))
  for (let at = 1; at <= 20; at += 1) source().put("deal", exampleDeal(`d${at}`, { assignee: "9" }))
  await set("scope", "all")
  await sync()
  await raw("scope", undefined)
  expect(dealOf(await sync())).toMatchObject({ held: true })
  source().put("deal", exampleDeal("x1", { assignee: "9" }))
  source().put("deal", exampleDeal("x2", { assignee: "9" }))
  source().put("deal", exampleDeal("d1", { assignee: "8", title: "Moved on" }))
  expect(dealOf(await sync())).toMatchObject({ held: true })
  expect(await deals()).toHaveLength(21)

  await set("scope", "all")
  expect(dealOf(await sync())).toMatchObject({ round: "full" })
  expect(await deals()).toHaveLength(23)
  const [moved] = (await store.deals.list({ account: PORTAL, kind: "deal" })).filter(
    ({ externalId }) => externalId === "d1",
  )
  expect(moved?.title).toBe("Moved on")
})

it("store status gives each deal and lead kind its saved scope and the one its copy holds, without a sync", async () => {
  const { store, source, set, raw, sync } = await scoped()
  const scopes = async () =>
    Object.fromEntries(
      (await crmStatus(store, PORTAL, { profile: "work", now: Date.now() })).items.map((one) => [
        one.kind,
        "scope" in one ? one.scope : undefined,
      ]),
    )
  expect(await scopes()).toEqual({
    organization: undefined,
    person: undefined,
    deal: { setting: "mine", explicit: false, applied: null },
    lead: { setting: "mine", explicit: false, applied: null },
  })
  source().put("deal", exampleDeal("d0", { assignee: "7" }))
  for (let at = 1; at <= 3; at += 1) source().put("deal", exampleDeal(`d${at}`, { assignee: "9" }))
  await set("scope", "all")
  await sync()
  expect((await scopes()).deal).toEqual({ setting: "all", explicit: true, applied: { mode: "all" } })
  await raw("scope", undefined)
  expect(dealOf(await sync())).toMatchObject({ held: true })
  expect((await scopes()).deal).toEqual({
    setting: "mine",
    explicit: false,
    applied: { mode: "mine", users: ["7"] },
    held: true,
  })
  await set("scope", "mine")
  expect(dealOf(await sync())?.held).toBeUndefined()
  expect((await scopes()).deal).toEqual({ setting: "mine", explicit: true, applied: { mode: "mine", users: ["7"] } })
  await set("unassigned", "15")
  await sync()
  expect((await scopes()).deal).toEqual({
    setting: "mine",
    explicit: true,
    applied: { mode: "mine", users: ["15", "7"] },
  })
})

it("narrows at once when the owner set scope mine, however much it removes", async () => {
  const { source, set, sync, deals } = await scoped()
  source().put("deal", exampleDeal("d0", { assignee: "7" }))
  for (let at = 1; at <= 3; at += 1) source().put("deal", exampleDeal(`d${at}`, { assignee: "9" }))
  await set("scope", "all")
  await sync()
  await set("scope", "mine")
  const narrowed = await sync()
  expect(narrowed.issues.map(({ reason }) => reason)).not.toContain("crm.narrowing-held")
  expect(dealOf(narrowed)?.outOfScope).toBe(3)
  expect(await deals()).toEqual(["d0"])
})

it("copies every deal of a CRM that names no own user, and says so", async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "crm-unscoped-")), "store.db") })
  stores.push(store)
  const source = fakeCrmSource()
  source.put("deal", exampleDeal("d1", { assignee: "9" }))
  expect((await syncCrm(source, store, PORTAL)).scope).toEqual({ mode: "all" })
  expect(await store.deals.list({ account: PORTAL, kind: "deal" })).toHaveLength(1)
})

it("takes a scope of mine or all and the CRM's user ids as unassigned", () => {
  expect(parseCrmSettingValue("scope", " all ")).toBe("all")
  expect(() => parseCrmSettingValue("scope", "team")).toThrow(/mine or all/)
  expect(parseCrmSettingValue("unassigned", "12, 15,12")).toEqual(["12", "15"])
  for (const [value, bad] of [
    ["12;15", "12;15"],
    ["12,bot", "bot"],
    ["12,,15", ""],
  ])
    expect(() => parseCrmSettingValue("unassigned", value as string)).toThrow(
      `numeric user ids, comma-separated: not "${bad}"`,
    )
})
