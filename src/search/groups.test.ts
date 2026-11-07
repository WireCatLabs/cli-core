import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { liftProfile, runGroup } from "../cli/profile.js"
import { addGroupMember, listAccountGroups, moveGroupMember, removeGroupMember } from "../services/account-groups.js"
import { prepareLucene } from "../services/messages-search.js"
import { listContextOf, listedAccounts } from "../services/search-kind.js"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
import { accountsOfList, sameAs, sourceOf } from "./account-list.js"
import { inGroupOf, type RunGroup, scopeToGroup } from "./groups.js"

const tgPersonal: AccountKey = { provider: "telegram", account: "101" }
const tgWork: AccountKey = { provider: "telegram", account: "102" }
const b24Work: AccountKey = { provider: "bitrix24", account: "acme.bitrix24.ru" }
const home: AccountKey = { provider: "email", account: "me@example.com" }
const office: AccountKey = { provider: "email", account: "me@work.example" }

const app = { command: "memo", appName: "groups-test", envPrefix: "MEMO", description: "", version: "0" }
const LOCKED = { MEMO_GROUP_LOCK: "work" }

const live: MessageStore[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const store of live.splice(0)) await store.close()
})

const opened = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "groups-")), "store.db") })
  live.push(store)
  return store
}

const owner = async () => {
  const store = await opened()
  for (const key of [tgPersonal, tgWork, b24Work, home, office]) await store.accounts.saveAccount(key, { name: null })
  await store.accounts.saveProfile("tg", "personal", tgPersonal)
  await store.accounts.saveProfile("tg", "work", tgWork)
  await store.accounts.saveProfile("b24", "work", b24Work)
  return store
}

const withWork = async () => {
  const store = await owner()
  await store.accounts.saveAccountGroup("work", ["telegram:102", `bitrix24:${b24Work.account}`])
  return store
}

const contextOf = (store: MessageStore, env: NodeJS.ProcessEnv = {}) => listContextOf(store, home, app, undefined, env)
const sorted = (keys: AccountKey[]) => keys.map(sourceOf).sort()
const members = async (store: MessageStore, group: string) =>
  sorted(accountsOfList(`group:${group}`, await contextOf(store)))
const inGroup = (name: string, locked = false, from = "first word"): RunGroup => ({ name, from, locked })
const lockedRun = runGroup(app, LOCKED) as RunGroup

describe("who is in a group", () => {
  it("leaves memo's own notes and an unsaved running account out of every group", async () => {
    const store = await owner()
    const { membership } = await listContextOf(store, { provider: "telegram", account: "999" }, app, undefined, {})
    expect(membership.groups.personal?.map(sourceOf)).not.toContain("notes:internal")
    expect(membership.groups.personal?.map(sourceOf)).not.toContain("telegram:999")
  })

  it("is everyone in personal when nothing is saved, with work refused and its profiles suggested", async () => {
    const store = await owner()
    const context = await contextOf(store)
    expect(await members(store, "personal")).toEqual(sorted([tgPersonal, tgWork, b24Work, home, office]))
    expect(() => scopeToGroup(inGroup("work"), {}, context)).toThrow(
      expect.objectContaining({
        code: "validation_error",
        message: expect.stringMatching(/groups here: personal; profiles named work suggest telegram:102, bitrix24:/),
      }),
    )
    expect(context.membership.suggested).toEqual([
      { group: "work", member: "telegram:102", because: "profile named work (tg work)" },
      { group: "work", member: "bitrix24:acme.bitrix24.ru", because: "profile named work (b24 work)" },
    ])
  })

  it("is exactly the saved list, and personal is every account in no other group", async () => {
    const store = await withWork()
    expect(await members(store, "work")).toEqual(sorted([tgWork, b24Work]))
    expect(await members(store, "personal")).toEqual(sorted([tgPersonal, home, office]))
    const { membership } = await contextOf(store)
    expect(membership.groups.work?.[0]).toEqual({
      ...tgWork,
      entries: ["telegram:102"],
      reason: "setting",
      profiles: ["tg work"],
      also_in: [],
    })
    expect(membership.groups.personal?.every(({ reason }) => reason === "in no other group")).toBe(true)
    expect(membership.suggested).toEqual([])
    expect(membership.duplicates).toEqual([])
  })

  it("allows an account in personal too when personal lists it, and reports the duplicate", async () => {
    const store = await withWork()
    await store.accounts.saveAccountGroup("personal", ["tg:work"])
    expect(await members(store, "personal")).toEqual(sorted([tgPersonal, tgWork, home, office]))
    const { membership } = await contextOf(store)
    expect(membership.groups.work?.[0]?.also_in).toEqual(["personal"])
    expect(membership.groups.personal?.[0]).toMatchObject({ ...tgWork, reason: "setting", also_in: ["work"] })
    expect(membership.groups.personal?.slice(1).every(({ reason }) => reason === "in no other group")).toBe(true)
    expect(membership.duplicates).toEqual([{ member: "telegram:102", groups: ["work", "personal"] }])
  })

  it("keeps every saved entry that names one account", async () => {
    const store = await owner()
    await store.accounts.saveAccountGroup("work", ["telegram:102", "tg:work"])
    expect((await contextOf(store)).membership.groups.work?.[0]?.entries).toEqual(["telegram:102", "tg:work"])
  })

  it("suggests only a profile name another app or a saved group shares, never all, bots or personal", async () => {
    const store = await owner()
    await store.accounts.saveProfile("max", "bots", { provider: "max", account: "9" })
    await store.accounts.saveProfile("max", "default", { provider: "max", account: "8" })
    await store.accounts.saveProfile("gcal", "personal", home)
    const { membership } = await contextOf(store)
    expect(membership.suggested.map(({ group }) => group)).toEqual(["work", "work"])
    expect(Object.keys(membership.groups)).toEqual(["personal"])
    await store.accounts.saveAccountGroup("default", [sourceOf(office)])
    expect((await contextOf(store)).membership.suggested.map(({ member }) => member)).toContain("max:8")
  })
})

describe("inGroupOf", () => {
  it("holds a group's members, memo's own notes for personal only, and no group that does not exist", async () => {
    const context = await contextOf(await withWork())
    const notes = { provider: "notes", account: "internal" }
    expect(inGroupOf(context, "work")(tgWork)).toBe(true)
    expect(inGroupOf(context, "work")(tgPersonal)).toBe(false)
    expect(inGroupOf(context, "work")(notes)).toBe(false)
    expect(inGroupOf(context, "personal")(notes)).toBe(true)
    expect(inGroupOf(context, "toString")(tgWork)).toBe(false)
  })
})

describe("a run in a group", () => {
  it("reads the group when no --source is named, and a bare provider keeps the group's accounts of it", async () => {
    const context = await contextOf(await withWork())
    expect(scopeToGroup(inGroup("work"), {}, context)).toEqual({ source: "group:work" })
    expect(scopeToGroup(inGroup("work"), { source: "telegram" }, context)).toEqual({ source: "telegram:102" })
    expect(scopeToGroup(inGroup("work"), { source: "telegram:102" }, context)).toEqual({ source: "telegram:102" })
  })

  it("refuses an account outside the group by what was typed, for a read and for a write's --account", async () => {
    const context = await contextOf(await withWork())
    for (const source of ["telegram:101", "telegram:102,group:personal"])
      expect(() => scopeToGroup(inGroup("work"), { source }, context)).toThrow(
        expect.objectContaining({
          code: "validation_error",
          message: expect.stringMatching(new RegExp(`${source.split(",").at(-1)} is outside`)),
        }),
      )
    expect(() => scopeToGroup(inGroup("work"), { account: "email:me@example.com" }, context)).toThrow(
      expect.objectContaining({ code: "validation_error" }),
    )
    expect(scopeToGroup(inGroup("work"), { account: "tg:work" }, context)).toEqual({
      source: "group:work",
      account: "tg:work",
    })
  })

  it("refuses all anywhere in --source", async () => {
    const context = await contextOf(await withWork())
    expect(() => scopeToGroup(inGroup("work"), { source: "telegram:102, all" }, context)).toThrow(/--source all/)
  })

  it("fails up front on an empty group", async () => {
    const store = await withWork()
    await store.accounts.saveAccountGroup("empty", [])
    const context = await contextOf(store)
    expect(() => scopeToGroup(inGroup("empty"), {}, context)).toThrow("group empty is empty")
  })

  it("says a mistyped first word, or a name only an object has, is neither a command nor a group", async () => {
    const context = await contextOf(await withWork())
    for (const word of ["serch", "toString", "constructor"])
      expect(() => scopeToGroup(inGroup(word), {}, context)).toThrow(
        new RegExp(`"${word}" is neither a command nor a group — groups here: work, personal`),
      )
  })

  it("reads a group from search mail too, keeping only its mailboxes", async () => {
    const store = await owner()
    await store.accounts.saveAccountGroup("work", ["telegram:102", `email:${office.account}`])
    expect((await listedAccounts(store, home, "group:work", app, "mail"))?.accounts).toEqual([office])
  })
})

describe("the group word and the lock", () => {
  const words = new Set(["search", "help"])

  it("is the first word past options, a valued option's value and never a command word or what follows --", () => {
    expect(liftProfile(["--json", "work", "search", "all"], words)).toEqual({
      profile: "work",
      rest: ["--json", "search", "all"],
    })
    expect(liftProfile(["--timeout", "30s", "work", "search"], words, new Set(["--timeout"]))).toEqual({
      profile: "work",
      rest: ["--timeout", "30s", "search"],
    })
    expect(liftProfile(["--", "work", "search"], words)).toEqual({ rest: ["--", "work", "search"] })
    expect(liftProfile(["search", "all"], words)).toEqual({ rest: ["search", "all"] })
  })

  it("reads MEMO_GROUP, takes all as no group, the word over the variable, and refuses a name that is no group name", () => {
    expect(runGroup(app, { MEMO_GROUP: "work" })).toEqual({ name: "work", from: "MEMO_GROUP", locked: false })
    expect(runGroup(app, { MEMO_GROUP: "work" }, "personal")).toMatchObject({ name: "personal" })
    expect(runGroup(app, {}, "all")).toBeUndefined()
    expect(runGroup(app, {})).toBeUndefined()
    expect(() => runGroup(app, {}, "a/../b")).toThrow(expect.objectContaining({ code: "validation_error" }))
  })

  it("refuses another group and all under MEMO_GROUP_LOCK, and runs in the locked group otherwise", () => {
    expect(lockedRun).toEqual({ name: "work", from: "MEMO_GROUP_LOCK", locked: true })
    expect(runGroup(app, LOCKED, "work")).toMatchObject({ locked: true })
    for (const word of ["personal", "all"])
      expect(() => runGroup(app, LOCKED, word)).toThrow(expect.objectContaining({ code: "permission_error" }))
    expect(() => runGroup(app, { ...LOCKED, MEMO_GROUP: "personal" })).toThrow(
      expect.objectContaining({ code: "permission_error" }),
    )
  })

  it("refuses --source all and an outside source as permission_error under the lock", async () => {
    const context = await contextOf(await withWork(), LOCKED)
    for (const source of ["all", "telegram:101", "group:personal"])
      expect(() => scopeToGroup(lockedRun, { source }, context)).toThrow(
        expect.objectContaining({ code: "permission_error" }),
      )
    expect(() => scopeToGroup(lockedRun, { account: "email:me@example.com" }, context)).toThrow(
      expect.objectContaining({ code: "permission_error" }),
    )
  })

  it("holds only the group's accounts under the lock, so a reader that never scoped still sees nothing else", async () => {
    const store = await withWork()
    const context = await contextOf(store, LOCKED)
    expect(Object.keys(context.groups)).toEqual(["work"])
    expect(sorted(accountsOfList("all", context))).toEqual(sorted([tgWork, b24Work]))
    expect(sorted(accountsOfList("telegram", context))).toEqual(["telegram:102"])
    await expect(contextOf(store, { MEMO_GROUP_LOCK: "constructor" })).rejects.toThrow(
      expect.objectContaining({ code: "permission_error" }),
    )
  })

  it("keeps a search messages call, as the MCP search tool makes it, inside the group its env locks, never process.env", async () => {
    const store = await withWork()
    const scope = async (source?: string) =>
      (await prepareLucene(store, home, { limit: 10, ...(source ? { source } : {}) }, { app, env: LOCKED }))
        .scopeAccounts
    expect(await scope()).toEqual([tgWork])
    expect(await scope("telegram")).toEqual([tgWork])
    expect(await scope("all")).toEqual([tgWork])
    vi.stubEnv("MEMO_GROUP_LOCK", "work")
    expect((await prepareLucene(store, home, { limit: 10 }, { app })).scopeAccounts).toEqual([home])
  })

  it("refuses a run locked to personal while a group entry names no account", async () => {
    const store = await owner()
    await store.accounts.saveAccountGroup("work", ["telegram:102", "email:gone@example.com"])
    const locked = runGroup(app, { MEMO_GROUP_LOCK: "personal" }) as RunGroup
    const context = await contextOf(store, { MEMO_GROUP_LOCK: "personal" })
    expect(() => scopeToGroup(locked, {}, context)).toThrow(
      expect.objectContaining({ code: "permission_error", message: expect.stringMatching(/email:gone@example.com/) }),
    )
  })
})

describe("changing a group, as a settings page does", () => {
  const at = async () => ({ store: await withWork(), account: home, app })

  it("lists only the locked group and changes nothing under the lock", async () => {
    const where = { ...(await at()), env: LOCKED }
    expect(Object.keys((await listAccountGroups(where)).groups)).toEqual(["work"])
    await expect(addGroupMember(where, { group: "work", member: "tg:personal" })).rejects.toThrow(
      expect.objectContaining({ code: "permission_error" }),
    )
  })

  it("adds a member under its stable key, and refuses a name that already means something", async () => {
    const where = await at()
    const after = await addGroupMember(where, { group: "clients", member: "tg:personal" })
    expect(after.groups.clients?.map(({ entries }) => entries)).toEqual([["telegram:101"]])
    expect(await where.store.accounts.accountGroups()).toMatchObject({ clients: ["telegram:101"] })
    for (const group of ["all", "search"])
      await expect(
        addGroupMember(where, { group, member: "tg:personal", reserved: new Set(["search"]) }),
      ).rejects.toThrow(/cannot name a group/)
    await expect(addGroupMember(where, { group: "x", member: "email" })).rejects.toThrow(/names 2 accounts/)
  })

  it("removes every entry that names only this account", async () => {
    const where = await at()
    await where.store.accounts.saveAccountGroup("work", ["telegram:102", "tg:work", `bitrix24:${b24Work.account}`])
    const after = await removeGroupMember(where, { group: "work", member: "telegram:102" })
    expect(after.groups.work?.map(sourceOf)).toEqual([`bitrix24:${b24Work.account}`])
    expect(await where.store.accounts.accountGroups()).toMatchObject({ work: [`bitrix24:${b24Work.account}`] })
  })

  it("refuses to remove an entry that names other accounts too, and says personal's rest leaves by joining", async () => {
    const where = await at()
    await where.store.accounts.saveAccountGroup("mail", ["email"])
    await expect(removeGroupMember(where, { group: "mail", member: sourceOf(home) })).rejects.toThrow(
      /email names more than this account/,
    )
    await where.store.accounts.saveAccountGroup("mail", undefined)
    await expect(removeGroupMember(where, { group: "personal", member: sourceOf(home) })).rejects.toThrow(
      /no other group/,
    )
    await expect(removeGroupMember(where, { group: "work", member: sourceOf(home) })).rejects.toThrow(
      expect.objectContaining({ code: "not_found" }),
    )
    await expect(removeGroupMember(where, { group: "toString", member: sourceOf(home) })).rejects.toThrow(
      /no group "toString"/,
    )
  })

  it("moves a member from one group to another in one write, every entry and personal's rest included", async () => {
    const where = await at()
    await where.store.accounts.saveAccountGroup("work", ["telegram:102", "tg:work", `bitrix24:${b24Work.account}`])
    const moved = await moveGroupMember(where, { member: "telegram:102", from: "work", to: "personal" })
    expect(moved.groups.work?.map(sourceOf)).toEqual([`bitrix24:${b24Work.account}`])
    expect(moved.groups.personal?.[0]).toMatchObject({ ...tgWork, reason: "setting", also_in: [] })
    expect(moved.duplicates).toEqual([])
    const back = await moveGroupMember(where, { member: sourceOf(home), from: "personal", to: "work" })
    expect(back.groups.work?.map(sourceOf)).toEqual([`bitrix24:${b24Work.account}`, sourceOf(home)])
    expect(back.groups.personal?.some(sameAs(home))).toBe(false)
  })
})
