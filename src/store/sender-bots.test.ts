import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import type { CacheDatabase } from "./driver.js"
import { openCache } from "./open.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const TG: AccountKey = { provider: "telegram", account: "1" }
const MAIL: AccountKey = { provider: "email", account: "me@acme.ru" }
const CRM: AccountKey = { provider: "bitrix24", account: "portal" }

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const opened = async (path = join(mkdtempSync(join(tmpdir(), "sender-bots-")), "store.db")) => {
  const store = await openStore({ path })
  handles.push(store)
  await store.people.savePeople(TG, [{ id: "1", name: "Me" }])
  await store.people.linkToOwner({ provider: "telegram", id: "1" })
  await store.accounts.saveAccount(MAIL, { name: null })
  const db = await openCache(path)
  handles.push(db)
  return { store, db, path }
}

const uidOf = async (store: MessageStore, provider: string, id: string) =>
  `person:${(await store.people.personOf({ provider, id }))?.uid}`

const people = async (store: MessageStore) =>
  (await store.people.list({ limit: 100, kind: "all" })).items.map(({ displayName }) => displayName)

const bots = async (store: MessageStore) =>
  (await store.people.listBots({ limit: 100 })).items.map(({ displayName, identities, author }) => ({
    displayName,
    identities: identities.map(({ provider, id }) => `${provider}:${id}`),
    author,
  }))

const moves = (db: CacheDatabase) =>
  db.prepare("SELECT from_person_id, from_bot_id, to_person_id, to_bot_id, author, reason FROM sender_bot_moves").all()

const count = (db: CacheDatabase, sql: string) => Number(db.prepare(sql).get()?.n)

it("gives a program's identities to a bot of its own, apart from people, and a sync gives it no person again", async () => {
  const { store, db } = await opened()
  await store.people.savePeople(MAIL, [
    { id: "noreply-4471@bank.ru", name: "Bank" },
    { id: "lena@acme.ru", name: "Lena Marsh" },
  ])
  await store.people.savePeople(TG, [
    { id: "50", name: "Helper", isBot: true },
    { id: "51", name: "Weather Notifications" },
  ])
  const bank = await uidOf(store, "email", "noreply-4471@bank.ru")

  const listed = await people(store)

  // A name alone may be a human's newsletter: marked, not moved.
  expect(listed).toEqual(expect.arrayContaining(["Lena Marsh", "Weather Notifications"]))
  expect(listed).not.toContain("Bank")
  expect(listed).not.toContain("Helper")
  expect(await bots(store)).toEqual([
    { displayName: "Bank", identities: ["email:noreply-4471@bank.ru"], author: "rules" },
    { displayName: "Helper", identities: ["telegram:50"], author: "rules" },
  ])
  expect(await store.people.personOf({ provider: "email", id: "noreply-4471@bank.ru" })).toBeUndefined()
  await expect(
    store.people.linkIdentities(
      { provider: "email", id: "lena@acme.ru" },
      { provider: "email", id: "noreply-4471@bank.ru" },
      { method: "manual", by: "owner" },
    ),
  ).rejects.toMatchObject({
    details: { reason: "sender-bot.not-a-person" },
  })
  expect(moves(db)).toEqual(
    expect.arrayContaining([expect.objectContaining({ author: "rules", reason: "no-reply", to_person_id: null })]),
  )
  const persons = count(db, "SELECT count(*) AS n FROM persons")

  await store.people.savePeople(MAIL, [{ id: "noreply-4471@bank.ru", name: "Bank" }])
  await store.people.savePeople(TG, [{ id: "50", name: "Helper", isBot: true }])

  expect(count(db, "SELECT count(*) AS n FROM persons")).toBe(persons)
  expect(await bots(store)).toHaveLength(2)
  expect((await store.people.list({ limit: 0, kind: "automated" })).counts.automated).toBe(1)
  expect(await store.people.ties([bank])).toEqual({ [bank]: [] })
  expect((await store.people.similar("Bank")).map(({ person }) => person)).not.toContain(bank)
  // The person ref a reader kept from before still names the bot, and a move back gives it back.
  expect(`person:${(await store.people.moveToPerson(bank, "owner")).uid}`).toBe(bank)
  expect(await people(store)).toContain("Bank")
})

it("keeps the owner's choice both ways, through the rules and a change of them, and gives the uid back", async () => {
  const { store, db } = await opened()
  await store.people.savePeople(MAIL, [
    { id: "mark@shop.ru", name: "Shop" },
    { id: "noreply@bank.ru", name: "Bank" },
  ])
  const shop = await uidOf(store, "email", "mark@shop.ru")
  await store.people.list({ limit: 0 })

  await expect(store.people.moveToBot(shop, { bot: "agent", reason: "guess" })).rejects.toMatchObject({
    details: { reason: "identity.owner-only" },
  })
  const shopBot = await store.people.moveToBot(shop, "owner", { name: "Shop alerts", reason: "a program" })
  const bankPerson = await store.people.moveToPerson({ provider: "email", id: "noreply@bank.ru" }, "owner", {
    reason: "my banker writes from it",
  })
  db.prepare("UPDATE store_settings SET value = '6' WHERE key = 'people.kind_rules'").run()

  expect(shopBot).toMatchObject({ name: "Shop alerts", displayName: "Shop alerts", author: "owner" })
  expect(await store.people.showBot(shopBot.bot)).toMatchObject({
    identities: [{ provider: "email", id: "mark@shop.ru" }],
    moves: [{ identity: { provider: "email", id: "mark@shop.ru" }, from: shop, to: shopBot.bot, author: "owner" }],
  })
  expect(await people(store)).toEqual(["Me", "Bank"])
  expect(await bots(store)).toEqual([
    { displayName: "Shop alerts", identities: ["email:mark@shop.ru"], author: "owner" },
  ])

  const back = await store.people.moveToPerson(shopBot.bot, "owner")
  expect(`person:${back.uid}`).toBe(shop)
  expect(`person:${bankPerson.uid}`).toBe(await uidOf(store, "email", "noreply@bank.ru"))
  expect(await bots(store)).toEqual([])
  expect(count(db, "SELECT count(*) AS n FROM sender_bots")).toBe(0)
  expect(await people(store)).toEqual(expect.arrayContaining(["Shop", "Bank"]))
  await expect(store.people.moveToBot("person:1", "owner")).rejects.toMatchObject({
    details: { reason: "sender-bot.owner" },
  })
})

it("moves one identity of a person with others to a bot, and another into the same bot, with no person row", async () => {
  const { store, db } = await opened()
  await store.people.savePeople(TG, [
    { id: "60", name: "Ola" },
    { id: "61", name: "Ola" },
    { id: "62", name: "Ola" },
  ])
  for (const id of ["61", "62"])
    await store.people.linkIdentities(
      { provider: "telegram", id: "60" },
      { provider: "telegram", id },
      { method: "manual", by: "owner" },
    )
  const ola = await uidOf(store, "telegram", "60")
  const persons = count(db, "SELECT count(*) AS n FROM persons")

  const bot = await store.people.moveToBot({ provider: "telegram", id: "61" }, "owner")
  const joined = await store.people.moveToBot({ provider: "telegram", id: "62" }, "owner", { bot: bot.bot })

  expect(joined.bot).toBe(bot.bot)
  expect(joined.identities.map(({ id }) => id)).toEqual(["61", "62"])
  expect(await uidOf(store, "telegram", "60")).toBe(ola)
  expect(count(db, "SELECT count(*) AS n FROM persons")).toBe(persons)

  const home = await store.people.moveToPerson({ provider: "telegram", id: "61" }, "owner", { person: ola })
  expect(`person:${home.uid}`).toBe(ola)
  expect((await store.people.showBot(bot.bot)).identities.map(({ id }) => id)).toEqual(["62"])
})

it("never joins a bot to a person by an address, nor makes the person it left a task's assignee", async () => {
  const { store, db } = await opened()
  await store.people.savePeople(CRM, [{ id: "contact/20", name: "Alice Example", email: "alice@acme.example" }])
  await store.people.savePeople(TG, [{ id: "5", name: "Alice" }])
  const tg = await uidOf(store, "telegram", "5")
  await store.people.moveToBot(tg, "owner")
  db.prepare(
    "UPDATE identities SET email = 'alice@acme.example' WHERE provider = 'telegram' AND external_id = '5'",
  ).run()

  const scan = await store.people.scanMatches()

  expect(scan.merged).toEqual([])
  expect(await store.people.personOf({ provider: "telegram", id: "5" })).toBeUndefined()
  await store.knowledge.addProject({ name: "Harbour", key: "HRB", type: "work" })
  const task = await store.tasks.create({ project: "HRB", title: "Ship", type: "chore" }, "owner")
  await expect(store.tasks.assign(task.id, { to: tg, role: "assignee" }, "owner")).rejects.toMatchObject({
    details: { reason: "sender-bot.assignee" },
  })
})

it("gives a rule's bot back to the person it came from once the owner writes to it", async () => {
  const { store, db } = await opened()
  await store.people.savePeople(MAIL, [{ id: "noreply@bank.ru", name: "Bank" }])
  const bank = await uidOf(store, "email", "noreply@bank.ru")
  expect(await bots(store)).toHaveLength(1)
  const account = Number(db.prepare("SELECT id FROM accounts WHERE provider = 'email'").get()?.id)
  const at = Date.now()
  const thread = db
    .prepare(
      "INSERT INTO email_threads (account_id, external_id, created_at, updated_at) VALUES (?, 't1', ?, ?) RETURNING id",
    )
    .get(account, at, at)?.id as number
  const sent = db
    .prepare(
      "INSERT INTO emails (account_id, email_thread_id, external_id, outgoing, created_at, updated_at) " +
        "VALUES (?, ?, 'm1', 1, ?, ?) RETURNING id",
    )
    .get(account, thread, at, at)?.id as number
  const identity = db.prepare("SELECT id FROM identities WHERE external_id = 'noreply@bank.ru'").get()?.id as number
  db.prepare(
    "INSERT INTO email_recipients (email_id, identity_id, address, role, position, created_at, updated_at) " +
      "VALUES (?, ?, 'noreply@bank.ru', 'to', 0, ?, ?)",
  ).run(sent, identity, at, at)
  db.prepare("UPDATE persons SET kind = NULL WHERE owner = 1").run()

  expect(await bots(store)).toEqual([])
  expect(await uidOf(store, "email", "noreply@bank.ru")).toBe(bank)
  const listed = (await store.people.list({ limit: 10, kind: "automated" })).items
  // Still marked by its address, but the owner wrote to it: a person, not a bot.
  expect(listed.map(({ person, ties }) => ({ person, ties }))).toEqual([{ person: bank, ties: ["mail"] }])
  expect(
    moves(db).map(({ author, to_bot_id, to_person_id }) => [author, to_bot_id !== null, to_person_id !== null]),
  ).toEqual([
    ["rules", true, false],
    ["rules", false, true],
  ])
})

it("lets an account purge take a bot's rows with its identities", async () => {
  const { store, db } = await opened()
  await store.people.savePeople(TG, [
    { id: "50", name: "Helper", isBot: true },
    { id: "51", name: "Notifier", isBot: true },
  ])
  expect(await bots(store)).toHaveLength(2)

  const persons = count(db, "SELECT count(*) AS n FROM persons")

  await store.accounts.purge(TG)

  // The person rows the bots emptied go with them, as a purged identity's person does.
  expect(count(db, "SELECT count(*) AS n FROM persons")).toBe(persons - 2)
  expect(count(db, "SELECT count(*) AS n FROM sender_bots")).toBe(0)
  expect(count(db, "SELECT count(*) AS n FROM sender_bot_identities")).toBe(0)
  expect(count(db, "SELECT count(*) AS n FROM sender_bot_moves")).toBe(0)
})

it("never proposes the person a bot left as the same person by name", async () => {
  const { store } = await opened()
  await store.people.savePeople(MAIL, [{ id: "noreply@lane.ru", name: "Pat Lane" }])
  const bot = await uidOf(store, "email", "noreply@lane.ru")
  await store.people.savePeople(TG, [{ id: "70", name: "Pat Lane" }])
  await store.people.list({ limit: 0 })

  const scan = await store.people.scanMatches({ full: true })

  const named = [
    ...scan.merged.flatMap(({ into, from }) => [into, from]),
    ...scan.proposed.flatMap((one) => one.persons),
  ]
  expect(named).not.toContain(bot.replace("person:", ""))
})

it("finds bots by name and address and by the organization of their domain", async () => {
  const { store } = await opened()
  await store.people.savePeople(MAIL, [
    { id: "noreply@mail.bank.ru", name: "Bank" },
    { id: "alerts@shop.ru", name: "Shop" },
  ])
  const all = await store.people.listBots({ limit: 1 })
  const [bank] = (await store.people.listBots({ limit: 10, query: "bank.ru" })).items

  expect(all).toMatchObject({ total: 2, hasMore: true })
  expect(bank).toMatchObject({ displayName: "Bank", organization: expect.stringMatching(/^organization:\d+$/) })
  expect(
    (await store.people.listBots({ limit: 10, organization: String(bank?.organization) })).items.map(({ bot }) => bot),
  ).toEqual([bank?.bot])
  await expect(store.people.listBots({ limit: 10, query: "ba" })).rejects.toMatchObject({
    details: { reason: "query.short-text" },
  })
})

it("keeps one holder through a re-key: the bot takes the identity that stays, from either side", async () => {
  const { store, db } = await opened()
  const held = (id: string) =>
    db
      .prepare(
        "SELECT (SELECT count(*) FROM identity_links l WHERE l.identity_id = i.id) AS links, " +
          "(SELECT count(*) FROM sender_bot_identities s WHERE s.identity_id = i.id) AS bots " +
          "FROM identities i WHERE i.provider = 'telegram' AND i.external_id = ?",
      )
      .get(id)
  await store.people.savePeople(TG, [
    { id: "80", name: "Old Bot", isBot: true },
    { id: "81", name: "New Bot" },
    { id: "90", name: "Old Kim" },
    { id: "91", name: "New Kim" },
  ])
  const kim = await uidOf(store, "telegram", "90")
  await store.people.list({ limit: 0 })
  const [bot] = (await store.people.listBots({ limit: 10 })).items
  const other = await store.people.moveToBot({ provider: "telegram", id: "91" }, "owner")

  await store.people.rekeyIdentities("telegram", [
    { from: "80", to: "81" },
    { from: "90", to: "91" },
  ])

  expect(held("81")).toEqual({ links: 0, bots: 1 })
  expect(held("91")).toEqual({ links: 0, bots: 1 })
  expect((await store.people.showBot(String(bot?.bot))).identities.map(({ id }) => id)).toEqual(["81"])
  expect((await store.people.showBot(other.bot)).identities.map(({ id }) => id)).toEqual(["91"])
  expect(await people(store)).not.toContain("Old Kim")
  expect((await store.people.showBot(other.bot)).moves).toEqual(
    expect.arrayContaining([expect.objectContaining({ from: kim, reason: "the source re-keyed the identity" })]),
  )
})
