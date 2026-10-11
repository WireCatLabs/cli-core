import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
import { prepareLucene } from "./messages-search.js"
import type { SearchKind } from "./search-kind.js"

const tg1: AccountKey = { provider: "telegram", account: "101" }
const tg2: AccountKey = { provider: "telegram", account: "102" }
const max1: AccountKey = { provider: "max", account: "201" }
const max2: AccountKey = { provider: "max", account: "202" }
const home: AccountKey = { provider: "email", account: "me@example.com" }
const work: AccountKey = { provider: "email", account: "me@work.example" }
const NAMES = new Map([
  [tg1, "Alice Example"],
  [tg2, "Bob Sample"],
  [max1, "Alice Example"],
  [max2, "Carol Sample"],
])

const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})

const seeded = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "account-list-")), "store.db") })
  live.push(store)
  for (const key of [tg1, tg2, max1, max2, home, work]) await store.saveAccount(key, { name: NAMES.get(key) ?? null })
  return store
}

const app = {
  command: "tg",
  appName: "account-list-test",
  envPrefix: "ACCOUNT_LIST_TEST",
  description: "",
  version: "0",
}

const scope = async (store: MessageStore, source: string, kind?: SearchKind, text?: string) =>
  (
    await prepareLucene(
      store,
      tg1,
      { source, limit: 10, ...(kind ? { kind } : {}), ...(text ? { text } : {}) },
      { app },
    )
  ).scopeAccounts

describe("--source as a list of accounts and groups", () => {
  it("searches exactly the accounts of a group, from any messenger", async () => {
    const store = await seeded()
    await store.saveAccountGroup("work", ["tg:102", "max:Carol Sample", "email:me@work.example"])
    expect(await scope(store, "group:work")).toEqual([tg2, max2, work])
    expect(await scope(store, "group:work,telegram:101")).toEqual([tg2, max2, work, tg1])
  })

  it("finds a profile of any app that recorded it, while running as another", async () => {
    const store = await seeded()
    await store.saveProfile("tg", "mila", tg2)
    await store.saveProfile("max", "default", max1)
    await store.saveProfile("max", "work", max2)
    expect(await scope(store, "max:default,tg:mila")).toEqual([max1, tg2])
    expect(await scope(store, "telegram:mila,max:work")).toEqual([tg2, max2])
    await store.saveAccountGroup("work", ["tg:mila", "max:work"])
    expect(await scope(store, "group:work")).toEqual([tg2, max2])
    await expect(scope(store, "max:nobody")).rejects.toThrow(/profiles: default, work/)
  })

  it("takes a list without a group: ids, names and bare messenger words", async () => {
    const store = await seeded()
    expect(await scope(store, "telegram:Bob Sample,max:201")).toEqual([tg2, max1])
    expect(await scope(store, "max,email:me@example.com")).toEqual([max1, max2, home])
  })

  it("leaves mailboxes out of search messages and keeps only them in search mail", async () => {
    const store = await seeded()
    await store.saveAccountGroup("work", ["tg:102", "email:me@work.example"])
    expect(await scope(store, "group:work", "messages")).toEqual([tg2])
    expect(await scope(store, "group:work", "mail")).toEqual([work])
    await expect(scope(store, "email:me@work.example", "messages")).rejects.toThrow(/mailboxes only/)
    await expect(scope(store, "tg:102", "mail")).rejects.toThrow(/no mailbox/)
  })

  it("names what exists when a group or an account is unknown, or a name is ambiguous", async () => {
    const store = await seeded()
    await store.saveAccountGroup("work", ["tg:102"])
    await expect(scope(store, "group:home")).rejects.toThrow(/no account group "home" — there are work/)
    await expect(scope(store, "max:Dave")).rejects.toThrow(/max:201 \(Alice Example\), max:202 \(Carol Sample\)/)
    await expect(scope(store, "viber:1")).rejects.toThrow(/viber is not a messenger in the store/)
    await store.saveAccount({ provider: "max", account: "203" }, { name: "Carol Sample" })
    await expect(scope(store, "max:carol sample")).rejects.toThrow(/names more than one account/)
  })

  it("keeps a bare word meaning what it did, and refuses in: beside a list", async () => {
    const store = await seeded()
    expect(await scope(store, "max")).toEqual([max1, max2])
    await expect(scope(store, "max:201", undefined, "hello in:telegram")).rejects.toThrow(/leave in: out/)
  })

  it("forgets a removed group", async () => {
    const store = await seeded()
    await store.saveAccountGroup("work", ["tg:102"])
    await store.saveAccountGroup("work", undefined)
    expect(await store.accountGroups()).toEqual({})
  })
})
