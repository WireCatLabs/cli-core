import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { entriesOfList } from "../search/account-list.js"
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
  for (const key of [tg1, tg2, max1, max2, home, work])
    await store.accounts.saveAccount(key, { name: NAMES.get(key) ?? null })
  return store
}

const app = {
  command: "tg",
  appName: "account-list-test",
  envPrefix: "ACCOUNT_LIST_TEST",
  description: "",
  version: "0",
}

const prepared = (store: MessageStore, source: string, kind?: SearchKind, text?: string, running = app) =>
  prepareLucene(
    store,
    tg1,
    { source, limit: 10, ...(kind ? { kind } : {}), ...(text ? { text } : {}) },
    { app: running },
  )

const scope = async (store: MessageStore, source: string, kind?: SearchKind, text?: string) =>
  (await prepared(store, source, kind, text)).scopeAccounts

const zoom: AccountKey = { provider: "zoom", account: "z1" }

describe("--source as a list of accounts and groups", () => {
  it("searches exactly the accounts of a group, from any messenger", async () => {
    const store = await seeded()
    await store.accounts.saveAccountGroup("work", ["tg:102", "max:Carol Sample", "email:me@work.example"])
    expect(await scope(store, "group:work")).toEqual([tg2, max2, work])
    expect(await scope(store, "group:work,telegram:101")).toEqual([tg2, max2, work, tg1])
  })

  it("finds a profile of any app that recorded it, while running as another", async () => {
    const store = await seeded()
    await store.accounts.saveProfile("tg", "mila", tg2)
    await store.accounts.saveProfile("max", "default", max1)
    await store.accounts.saveProfile("max", "work", max2)
    expect(await scope(store, "max:default,tg:mila")).toEqual([max1, tg2])
    expect(await scope(store, "telegram:mila,max:work")).toEqual([tg2, max2])
    await store.accounts.saveAccountGroup("work", ["tg:mila", "max:work"])
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
    await store.accounts.saveAccountGroup("work", ["tg:102", "email:me@work.example"])
    expect(await scope(store, "group:work", "messages")).toEqual([tg2])
    expect(await scope(store, "group:work", "mail")).toEqual([work])
    await expect(scope(store, "email:me@work.example", "messages")).rejects.toThrow(
      /nothing tg search messages reads: email:me@work.example \(a mailbox/,
    )
    await expect(scope(store, "tg:102", "mail")).rejects.toThrow(/nothing tg search mail reads: tg:102/)
  })

  it("names what exists when a group or an account is unknown, or a name is ambiguous", async () => {
    const store = await seeded()
    await store.accounts.saveAccountGroup("work", ["tg:102"])
    await expect(scope(store, "group:home")).rejects.toThrow(/no account group "home" — there are work/)
    await expect(scope(store, "max:Dave")).rejects.toThrow(/max:201 \(Alice Example\), max:202 \(Carol Sample\)/)
    await expect(scope(store, "viber:1")).rejects.toThrow(/viber is not a provider — they are telegram \(tg\)/)
    await store.accounts.saveAccount({ provider: "max", account: "203" }, { name: "Carol Sample" })
    await expect(scope(store, "max:carol sample")).rejects.toThrow(/names more than one account/)
  })

  it("keeps a bare word meaning what it did, and refuses in: beside a list", async () => {
    const store = await seeded()
    expect(await scope(store, "max")).toEqual([max1, max2])
    await expect(scope(store, "max:201", undefined, "hello in:telegram")).rejects.toThrow(/leave in: out/)
  })

  it("resolves a bare kind or a provider's alias through the registry, whatever app runs", async () => {
    const store = await seeded()
    await store.accounts.saveAccount(zoom, { name: null })
    const asMax = { ...app, command: "max" }
    expect((await prepared(store, "tg", "messages", undefined, asMax)).scopeAccounts).toEqual([tg1, tg2])
    expect(await scope(store, "messages", "messages")).toEqual([max1, max2, tg1, tg2])
    expect(await scope(store, "mail", "mail")).toEqual([home, work])
    await expect(scope(store, "meetings", "messages")).rejects.toThrow(/zoom:z1|meetings \(meetings/)
  })

  it("keeps what a group of mixed kinds holds for this search and names the rest in skipped", async () => {
    const store = await seeded()
    await store.accounts.saveAccount(zoom, { name: null })
    const folder = await store.notes.addFolder({ name: "Vault" })
    await store.accounts.saveAccountGroup("work", ["tg:102", "email:me@work.example", `notes:${folder.id}`, "zoom:z1"])
    const found = await prepared(store, "group:work", "messages")
    expect(found.scopeAccounts).toEqual([tg2])
    expect(found.skipped).toEqual([
      { source: "email:me@work.example", code: "validation_error", reason: "a mailbox — memo search mail reads it" },
      { source: `notes:${folder.id}`, code: "validation_error", reason: "notes — search notes reads them" },
      { source: "zoom:z1", code: "validation_error", reason: "meetings — search all reads them" },
    ])
    expect((await prepared(store, "group:work", "mail")).scopeAccounts).toEqual([work])
  })

  it("searches messages only, and fails when nothing named is a messenger account", async () => {
    const store = await seeded()
    await store.accounts.saveAccount(zoom, { name: null })
    expect((await prepared(store, "tg:101,zoom:z1", "messages")).skipped).toEqual([
      { source: "zoom:z1", code: "validation_error", reason: "meetings — search all reads them" },
    ])
    expect(await scope(store, "all", "messages")).toEqual([max1, max2, tg1, tg2])
    await expect(scope(store, "zoom:z1", "messages")).rejects.toThrow(
      "--source names nothing tg search messages reads: zoom:z1 (meetings — search all reads them)",
    )
  })

  it("names a notes folder by the id its hits show, and memo's own notes as notes:internal", async () => {
    const store = await seeded()
    const folder = await store.notes.addFolder({ name: "Vault" })
    const context = {
      held: await store.accounts.storedAccounts(),
      groups: {},
      profiles: {},
      running: { provider: "telegram", command: "tg" },
    }
    expect(entriesOfList(`notes:${folder.id},notes:internal,notes:vault`, context)).toEqual([
      { entry: `notes:${folder.id}`, accounts: [{ provider: "notes", account: folder.id, kind: "notes" }] },
      { entry: "notes:internal", accounts: [{ provider: "notes", account: "internal", kind: "notes" }] },
      { entry: "notes:vault", accounts: [{ provider: "notes", account: folder.id, kind: "notes" }] },
    ])
    expect(entriesOfList("notes", context)[0]?.accounts.map(({ account }) => account)).toEqual(["internal", folder.id])
    expect(() => entriesOfList("folder:1", context)).toThrow(/folder is not a provider/)
  })

  it("keeps a Drive account in notes, named by its id, its drive profile or google-drive:<principal>", async () => {
    const store = await seeded()
    const drive = await store.notes.documentsAccount({ provider: "google-drive", account: "owner-1" }, true)
    const id = String(drive?.id)
    const context = {
      held: await store.accounts.storedAccounts(),
      groups: {},
      profiles: { drive: { work: { provider: "google-drive", account: "owner-1" } } },
      running: { provider: "telegram", command: "tg" },
    }
    const notes = [{ provider: "notes", account: id, kind: "notes" }]
    expect(entriesOfList(`notes:${id},drive:work,drive,google-drive:owner-1,google-drive`, context)).toEqual([
      { entry: `notes:${id}`, accounts: notes },
      { entry: "drive:work", accounts: notes },
      { entry: "drive", accounts: notes },
      { entry: "google-drive:owner-1", accounts: notes },
      { entry: "google-drive", accounts: notes },
    ])
    expect(entriesOfList("notes", context)[0]?.accounts.map(({ account }) => account)).toEqual(["internal", id])
    expect(() =>
      entriesOfList("drive:home", {
        ...context,
        profiles: { drive: { home: { provider: "google-drive", account: "owner-2" } } },
      }),
    ).toThrow(/no stored documents for drive:home/)
  })

  it("names the notes folders of one provider by it: obsidian for vaults, local for plain folders", async () => {
    const store = await seeded()
    const vault = await store.notes.addFolder({ name: "Vault" })
    const plain = await store.notes.addFolder({ name: "Plain", format: "markdown" })
    const context = {
      held: await store.accounts.storedAccounts(),
      groups: {},
      profiles: {},
      running: { provider: "telegram", command: "tg" },
    }
    const named = (word: string) => entriesOfList(word, context)[0]?.accounts.map(({ account }) => account)
    expect(named("obsidian")).toEqual([vault.id])
    expect(named("local")).toEqual([plain.id])
  })

  it("names one notes folder as obsidian:<id> or local:<id>, by its stored id, its id or its name", async () => {
    const store = await seeded()
    const vault = await store.notes.addFolder({ name: "Vault" })
    const plain = await store.notes.addFolder({ name: "Plain", format: "markdown" })
    const held = await store.accounts.storedAccounts()
    const ulidOf = (id: string) => String(held.find((one) => String(one.id) === id)?.account)
    await store.accounts.saveAccountGroup("work", [`local:${ulidOf(plain.id)}`])
    const context = {
      held,
      groups: await store.accounts.accountGroups(),
      profiles: {},
      running: { provider: "telegram", command: "tg" },
    }
    const named = (value: string) =>
      entriesOfList(value, context).flatMap(({ accounts }) => accounts.map(({ account }) => account))
    expect(named(`obsidian:${ulidOf(vault.id)},local:${ulidOf(plain.id).toLowerCase()}`)).toEqual([vault.id, plain.id])
    expect(named(`obsidian:${vault.id},local:plain,group:work`)).toEqual([vault.id, plain.id, plain.id])
    expect(entriesOfList(`local:${plain.id}`, context)[0]?.accounts).toEqual([
      { provider: "notes", account: plain.id, kind: "notes" },
    ])
    expect(() => entriesOfList(`obsidian:${ulidOf(plain.id)}`, context)).toThrow(
      `no obsidian account "${ulidOf(plain.id)}" — the store holds notes:${vault.id} (Vault)`,
    )
    expect(() => entriesOfList(`local:${vault.id}`, context)).toThrow(/no local account/)
  })

  it("forgets a removed group", async () => {
    const store = await seeded()
    await store.accounts.saveAccountGroup("work", ["tg:102"])
    await store.accounts.saveAccountGroup("work", undefined)
    expect(await store.accounts.accountGroups()).toEqual({})
  })
})
