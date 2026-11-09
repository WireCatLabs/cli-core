import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Chat } from "../domain/models.js"
import type { CacheDatabase } from "./driver.js"
import { openCache } from "./open.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const TG: AccountKey = { provider: "telegram", account: "1" }
const MAIL: AccountKey = { provider: "email", account: "me@example.test" }
const CRM: AccountKey = { provider: "bitrix24", account: "acme.example" }
const NOW = Date.parse("2026-11-01T12:00:00Z")

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const opened = async (): Promise<{ store: MessageStore; db: CacheDatabase }> => {
  const path = join(mkdtempSync(join(tmpdir(), "people-list-")), "store.db")
  const store = await openStore({ path })
  handles.push(store)
  await store.people.savePeople(TG, [{ id: "1", name: "Me" }])
  await store.people.linkToOwner({ provider: "telegram", id: "1" })
  const db = await openCache(path)
  handles.push(db)
  return { store, db }
}

const chat = (id: string, kind: Chat["kind"], participantsCount: number | null): Chat => ({
  id,
  title: id,
  kind,
  unreadCount: 0,
  lastMessageAt: null,
  participantsCount,
})

const named = async (store: MessageStore, people: { id: string; name: string }[]) => {
  await store.people.savePeople(TG, people)
  return Object.fromEntries(
    await Promise.all(
      people.map(async ({ id, name }) => [
        name,
        `person:${(await store.people.personOf({ provider: "telegram", id }))?.uid}`,
      ]),
    ),
  ) as Record<string, string>
}

const identityPk = (db: CacheDatabase, provider: string, id: string) =>
  Number(db.prepare("SELECT id FROM identities WHERE provider = ? AND external_id = ?").get(provider, id)?.id)

/** The people shown, the owner aside: the store's owner has no name of their own. */
const shownOf = async (store: MessageStore) =>
  Object.fromEntries(
    (await store.people.list({ limit: 100 })).items
      .filter(({ owner }) => !owner)
      .map(({ displayName, ties }) => [displayName, ties]),
  )

describe("people's ties to the owner", () => {
  it("shows a one-to-one chat and a group of up to 10, and hides a bigger or unsized group", async () => {
    const { store } = await opened()
    await named(store, [
      { id: "2", name: "Dina" },
      { id: "3", name: "Gala" },
      { id: "4", name: "Hugo" },
      { id: "5", name: "Ugo" },
    ])
    await store.chats.saveChats(TG, [chat("d", "dialog", 2), chat("ten", "group", 10), chat("big", "group", 11)])
    await store.chats.saveChats(TG, [chat("unsized", "group", null)])
    await store.roster.saveMembers(TG, "d", ["1", "2"])
    await store.roster.saveMembers(TG, "ten", ["1", "3"])
    await store.roster.saveMembers(TG, "big", ["1", "4"])
    await store.roster.saveMembers(TG, "unsized", ["1", "5"])

    const listed = await store.people.list({ limit: 100 })

    expect(await shownOf(store)).toEqual({ Dina: ["chat"], Gala: ["small-group"] })
    expect(listed.items[0]).toMatchObject({ owner: true, ties: ["owner", "chat", "small-group"] })
    expect(listed).toMatchObject({ total: 3, hidden: 2, hasMore: false })
    const everyone = await store.people.list({ limit: 100, all: true })
    expect(everyone.items.find(({ displayName }) => displayName === "Hugo")?.ties).toEqual([])
    expect(everyone).toMatchObject({ total: 5, hidden: 2 })
  })

  it("counts mail only when the owner wrote to them, not mail they sent", async () => {
    const { store, db } = await opened()
    await store.accounts.saveAccount(MAIL, { name: null })
    await store.people.savePeople(MAIL, [
      { id: "ann@example.test", name: "Ann" },
      { id: "news@shop.example", name: "Shop News" },
    ])
    const account = Number(db.prepare("SELECT id FROM accounts WHERE provider = 'email'").get()?.id)
    const thread = (n: number) =>
      Number(
        db
          .prepare(
            "INSERT INTO email_threads (account_id, external_id, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING id",
          )
          .get(account, `t${n}`, NOW, NOW)?.id,
      )
    const email = db.prepare(
      "INSERT INTO emails (account_id, email_thread_id, external_id, from_identity_id, outgoing, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    const recipient = db.prepare(
      "INSERT INTO email_recipients (email_id, identity_id, address, role, position, created_at, updated_at) " +
        "VALUES (?, ?, ?, 'to', 0, ?, ?)",
    )
    const sent = Number(email.get(account, thread(1), "m1", null, 1, NOW, NOW)?.id)
    recipient.run(sent, identityPk(db, "email", "ann@example.test"), "ann@example.test", NOW, NOW)
    const newsletter = Number(
      email.get(account, thread(2), "m2", identityPk(db, "email", "news@shop.example"), 0, NOW, NOW)?.id,
    )
    recipient.run(newsletter, null, "me@example.test", NOW, NOW)

    expect(await shownOf(store)).toEqual({ Ann: ["mail"] })
  })

  it("shows meeting guests, CRM contacts and the address book, and drops someone the book no longer has", async () => {
    const { store, db } = await opened()
    await store.accounts.registerProvider({ name: "bitrix24", kind: "crm", aliases: ["b24"], command: "b24" })
    await store.people.savePeople(CRM, [{ id: "contact/5", name: "Carla" }])
    await store.people.saveAddressBook(TG, [
      { id: "6", name: "Bea" },
      { id: "7", name: "Bo" },
    ])
    await named(store, [{ id: "8", name: "Mia" }])
    const account = Number(db.prepare("SELECT id FROM accounts WHERE provider = 'telegram'").get()?.id)
    const meeting = Number(
      db
        .prepare(
          "INSERT INTO meetings (account_id, external_id, created_at, updated_at) VALUES (?, 'x', ?, ?) RETURNING id",
        )
        .get(account, NOW, NOW)?.id,
    )
    db.prepare(
      "INSERT INTO meeting_participants (meeting_id, identity_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run(meeting, identityPk(db, "telegram", "8"), NOW, NOW)

    expect(await shownOf(store)).toMatchObject({
      Carla: ["crm"],
      Bea: ["phone-book"],
      Bo: ["phone-book"],
      Mia: ["meeting"],
    })

    await store.people.saveAddressBook(TG, [{ id: "6", name: "Bea" }])
    expect(Object.keys(await shownOf(store))).not.toContain("Bo")
  })

  it("always shows a person added by hand and anyone assigned a task", async () => {
    const { store } = await opened()
    const people = await named(store, [{ id: "9", name: "Tess" }])
    const added = await store.people.add({ name: "Nora" })
    await store.knowledge.addProject({ name: "Harbour", key: "HRB", type: "work" })
    const task = await store.tasks.create({ project: "HRB", title: "Ship", type: "chore" }, "owner")
    await store.tasks.assign(task.id, { to: people.Tess as string, role: "assignee" }, "owner")

    expect(await shownOf(store)).toMatchObject({ Nora: ["added"], Tess: ["task"] })
    expect(added.uid).toBeDefined()
  })

  it("gives a merged person every tie of every identity on them", async () => {
    const { store } = await opened()
    await named(store, [
      { id: "10", name: "Lea" },
      { id: "11", name: "Lea W" },
    ])
    await store.chats.saveChats(TG, [chat("d", "dialog", 2)])
    await store.roster.saveMembers(TG, "d", ["1", "11"])
    await store.people.linkIdentities(
      { provider: "telegram", id: "10" },
      { provider: "telegram", id: "11" },
      { method: "manual", by: "owner" },
    )

    const listed = await store.people.list({ limit: 100 })

    expect(listed.items.filter(({ owner }) => !owner).map(({ ties }) => ties)).toEqual([["chat"]])
    expect(listed.hidden).toBe(0)
  })
})

describe("the people list", () => {
  it("pages, searches, sorts by name and shows a junk name by its fallback", async () => {
    const { store } = await opened()
    await store.people.savePeople(TG, [
      { id: "20", name: '"Zed Quoted "' },
      { id: "21", name: "!$", username: "bang" },
      { id: "22", name: "Ada" },
    ])
    await store.chats.saveChats(
      TG,
      ["20", "21", "22"].map((id) => chat(`d${id}`, "dialog", 2)),
    )
    for (const id of ["20", "21", "22"]) await store.roster.saveMembers(TG, `d${id}`, ["1", id])

    const first = await store.people.list({ limit: 2, sort: "name" })
    const second = await store.people.list({ limit: 2, offset: 2, sort: "name" })

    expect(first.items.map(({ displayName, owner }) => (owner ? "owner" : displayName))).toEqual(["owner", "@bang"])
    expect(first).toMatchObject({ hasMore: true, total: 4 })
    expect(second.items.map(({ displayName, name }) => [displayName, name])).toEqual([
      ["Ada", "Ada"],
      ["Zed Quoted", '"Zed Quoted "'],
    ])
    expect(second.hasMore).toBe(false)
    expect((await store.people.list({ limit: 10, query: "quoted" })).items.map(({ name }) => name)).toEqual([
      '"Zed Quoted "',
    ])
    await expect(store.people.list({ limit: 10, query: "ab" })).rejects.toThrow("at least 3 characters")
  })
})

describe("similar people", () => {
  it("finds names starting like the typed words in any order, the same name first", async () => {
    const { store } = await opened()
    await store.people.savePeople(TG, [
      { id: "30", name: "Petrov Ivan" },
      { id: "31", name: "Ivan Petrovsky" },
      { id: "32", name: "Ivana Smith" },
    ])
    await store.people.add({ name: "Iván Petrov" })

    const found = await store.people.similar("ivan PETROV")

    expect(found.map(({ name, sameName }) => [name, sameName])).toEqual([
      ["Petrov Ivan", true],
      ["Ivan Petrovsky", false],
    ])
    expect((await store.people.similar("iv")).map(({ name }) => name)).toEqual(
      expect.arrayContaining(["Petrov Ivan", "Ivan Petrovsky", "Ivana Smith"]),
    )
    expect(await store.people.similar("!!")).toEqual([])
  })
})
