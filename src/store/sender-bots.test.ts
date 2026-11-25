import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { rollBackTo } from "../testing/older-store.js"
import type { CacheDatabase } from "./driver.js"
import { openCache } from "./open.js"
import { LIST_SENDERS } from "./sqlite/sender-signals.js"
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

const automated = async (store: MessageStore) =>
  (await store.people.list({ limit: 100, kind: "automated" })).items.map(({ person, displayName, bot, ties }) => ({
    person,
    displayName,
    bot,
    ties,
  }))

const moves = (db: CacheDatabase) =>
  db.prepare("SELECT from_person_id, from_bot_id, to_person_id, to_bot_id, author, reason FROM sender_bot_moves").all()

it("moves a program's address to a bot, lists it as automated under its person ref, and a sync keeps it there", async () => {
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
  const helper = await uidOf(store, "telegram", "50")

  const listed = await automated(store)

  expect(listed).toEqual(
    expect.arrayContaining([
      { person: bank, displayName: "Bank", bot: expect.stringMatching(/^sender-bot:\d+$/), ties: [] },
      { person: helper, displayName: "Helper", bot: expect.stringMatching(/^sender-bot:\d+$/), ties: [] },
      // A name alone may be a human's newsletter: marked, not moved.
      { person: await uidOf(store, "telegram", "51"), displayName: "Weather Notifications", bot: null, ties: [] },
    ]),
  )
  expect(listed).toHaveLength(3)
  expect(moves(db)).toEqual(
    expect.arrayContaining([expect.objectContaining({ author: "rules", reason: "no-reply", to_person_id: null })]),
  )
  const before = db.prepare("SELECT id, person_id, author FROM sender_bots ORDER BY id").all()

  await store.people.savePeople(MAIL, [{ id: "noreply-4471@bank.ru", name: "Bank" }])
  await store.people.savePeople(TG, [{ id: "50", name: "Helper", isBot: true }])

  expect(await automated(store)).toEqual(listed)
  expect(db.prepare("SELECT id, person_id, author FROM sender_bots ORDER BY id").all()).toEqual(before)
  expect((await store.people.list({ limit: 0, kind: "automated" })).counts.automated).toBe(3)
  expect(await store.people.ties([bank])).toEqual({ [bank]: [] })
  expect((await store.people.similar("Bank")).map(({ person }) => person)).not.toContain(bank)
})

it("keeps the owner's choice both ways, through the rules and a change of them, and logs each move", async () => {
  const { store, db } = await opened()
  await store.people.savePeople(MAIL, [
    { id: "alerts@shop.ru", name: "Shop" },
    { id: "noreply@bank.ru", name: "Bank" },
  ])
  const shop = await uidOf(store, "email", "alerts@shop.ru")
  const bank = await uidOf(store, "email", "noreply@bank.ru")
  await store.people.list({ limit: 0 })

  await expect(store.people.moveToBot(shop, { bot: "agent", reason: "guess" })).rejects.toMatchObject({
    details: { reason: "identity.owner-only" },
  })
  const shopBot = await store.people.moveToBot(shop, "owner", { name: "Shop alerts", reason: "a program" })
  const bankPerson = await store.people.moveToPerson(bank, "owner", { reason: "my banker writes from it" })
  db.prepare("UPDATE store_settings SET value = '6' WHERE key = 'people.kind_rules'").run()

  expect(shopBot).toMatchObject({ person: shop, name: "Shop alerts", author: "owner" })
  expect(await automated(store)).toEqual([{ person: shop, displayName: "Shop alerts", bot: shopBot.bot, ties: [] }])
  expect(bankPerson.uid).toBe(bank.replace("person:", ""))
  const listed = (await store.people.list({ limit: 100, kind: "all" })).items.find(({ person }) => person === bank)
  expect(listed).toMatchObject({ kind: "organization", bot: null })

  const back = await store.people.moveToPerson(shopBot.bot, "owner")
  expect(`person:${back.uid}`).toBe(shop)
  expect(await automated(store)).toEqual([])
  expect(db.prepare("SELECT count(*) AS n FROM sender_bots").get()).toEqual({ n: 0 })
  expect(
    moves(db)
      .filter(({ author }) => author === "owner")
      .map(({ to_bot_id, to_person_id }) => [to_bot_id !== null, to_person_id !== null]),
  ).toEqual([
    [true, false],
    [false, true],
    [false, true],
  ])
  await expect(store.people.moveToBot("person:1", "owner")).rejects.toMatchObject({
    details: { reason: "sender-bot.owner" },
  })
})

it("moves one identity of a person with others to a bot of its own, and into a bot already stored", async () => {
  const { store } = await opened()
  await store.people.savePeople(TG, [
    { id: "60", name: "Ola" },
    { id: "61", name: "Ola" },
    { id: "62", name: "Ola" },
  ])
  await store.people.linkIdentities(
    { provider: "telegram", id: "60" },
    { provider: "telegram", id: "61" },
    { method: "manual", by: "owner" },
  )
  await store.people.linkIdentities(
    { provider: "telegram", id: "60" },
    { provider: "telegram", id: "62" },
    { method: "manual", by: "owner" },
  )
  const ola = await uidOf(store, "telegram", "60")

  const bot = await store.people.moveToBot({ provider: "telegram", id: "61" }, "owner")
  const joined = await store.people.moveToBot({ provider: "telegram", id: "62" }, "owner", { bot: bot.bot })

  expect(joined.bot).toBe(bot.bot)
  expect(bot.person).not.toBe(ola)
  expect(await uidOf(store, "telegram", "60")).toBe(ola)
  expect(await uidOf(store, "telegram", "61")).toBe(bot.person)
  expect(await uidOf(store, "telegram", "62")).toBe(bot.person)
  expect((await automated(store)).map(({ person }) => person)).toEqual([bot.person])
  await expect(
    store.people.moveToPerson({ provider: "telegram", id: "61" }, "owner", { person: bot.person }),
  ).rejects.toMatchObject({ details: { reason: "sender-bot.not-a-person" } })

  const home = await store.people.moveToPerson({ provider: "telegram", id: "61" }, "owner", { person: ola })
  expect(`person:${home.uid}`).toBe(ola)
  expect(await uidOf(store, "telegram", "62")).toBe(bot.person)
})

it("never joins a bot to a person by an address, nor makes it a task's assignee", async () => {
  const { store, db } = await opened()
  await store.people.savePeople(CRM, [{ id: "contact/20", name: "Alice Example", email: "alice@acme.example" }])
  await store.people.savePeople(TG, [{ id: "5", name: "Alice" }])
  const tg = await uidOf(store, "telegram", "5")
  await store.people.moveToBot(tg, "owner")
  db.prepare(
    "UPDATE identities SET email = 'alice@acme.example' WHERE provider = 'telegram' AND external_id = '5'",
  ).run()

  const scan = await store.people.scanMatches()

  expect(await uidOf(store, "telegram", "5")).toBe(tg)
  expect(scan.merged).toEqual([])
  expect(scan.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "identity.not-a-person" })]))
  await store.knowledge.addProject({ name: "Harbour", key: "HRB", type: "work" })
  const task = await store.tasks.create({ project: "HRB", title: "Ship", type: "chore" }, "owner")
  await expect(store.tasks.assign(task.id, { to: tg, role: "assignee" }, "owner")).rejects.toMatchObject({
    details: { reason: "sender-bot.assignee" },
  })
})

it("gives a version 73 store the bot tables and the List-Id index, and moves its programs on the next list", async () => {
  const { store, path } = await opened()
  await store.people.savePeople(MAIL, [{ id: "no-reply@service.ru", name: "Service" }])
  await store.people.list({ limit: 0 })
  await store.close()
  handles.splice(handles.indexOf(store), 1)
  const old = await openCache(path)
  rollBackTo(old, 74)
  old.prepare("UPDATE store_settings SET value = '6' WHERE key = 'people.kind_rules'").run()
  expect(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sender_bots'").get()).toBeUndefined()
  old.close()

  const upgraded = await openStore({ path })
  handles.push(upgraded)
  const service = await uidOf(upgraded, "email", "no-reply@service.ru")

  expect((await automated(upgraded)).map(({ person, bot }) => [person, bot?.startsWith("sender-bot:")])).toEqual([
    [service, true],
  ])
  const db = await openCache(path)
  handles.push(db)
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${LIST_SENDERS}`)
    .all('["<news.example>"]')
    .map((row) => String(row.detail))
  expect(plan.join(" ")).toContain("emails_by_list_id")
})

it("gives a rule's bot back to a person once the owner writes to it, and logs the rule's move", async () => {
  const { store, db } = await opened()
  await store.people.savePeople(MAIL, [{ id: "noreply@bank.ru", name: "Bank" }])
  const bank = await uidOf(store, "email", "noreply@bank.ru")
  expect((await automated(store)).map(({ person }) => person)).toEqual([bank])
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

  // Still marked by its address, but the owner wrote to it: a person, not a bot.
  expect(await automated(store)).toEqual([{ person: bank, displayName: "Bank", bot: null, ties: ["mail"] }])
  expect(db.prepare("SELECT count(*) AS n FROM sender_bots").get()).toEqual({ n: 0 })
  expect(
    moves(db).map(({ author, to_bot_id, to_person_id }) => [author, to_bot_id !== null, to_person_id !== null]),
  ).toEqual([
    ["rules", true, false],
    ["rules", false, true],
  ])
})

it("lets an account purge and a person's erasure take a bot's rows with them", async () => {
  const { store, db } = await opened()
  await store.people.savePeople(TG, [
    { id: "50", name: "Helper", isBot: true },
    { id: "51", name: "Notifier", isBot: true },
  ])
  await store.people.list({ limit: 0 })
  expect(db.prepare("SELECT count(*) AS n FROM sender_bots").get()).toEqual({ n: 2 })

  await store.people.erase(await uidOf(store, "telegram", "51"), "owner", { apply: true })
  expect(db.prepare("SELECT count(*) AS n FROM sender_bots").get()).toEqual({ n: 1 })
  await store.accounts.purge(TG)

  expect(db.prepare("SELECT count(*) AS n FROM sender_bots").get()).toEqual({ n: 0 })
  expect(db.prepare("SELECT count(*) AS n FROM sender_bot_moves").get()).toEqual({ n: 0 })
})

it("never proposes a bot as the same person by name", async () => {
  const { store } = await opened()
  await store.people.savePeople(MAIL, [{ id: "noreply@lane.ru", name: "Pat Lane" }])
  await store.people.savePeople(TG, [{ id: "70", name: "Pat Lane" }])
  const bot = await uidOf(store, "email", "noreply@lane.ru")
  await store.people.list({ limit: 0 })

  const scan = await store.people.scanMatches({ full: true })

  const named = [
    ...scan.merged.flatMap(({ into, from }) => [into, from]),
    ...scan.proposed.flatMap((one) => one.persons),
  ]
  expect(named).not.toContain(bot.replace("person:", ""))
  expect(await uidOf(store, "email", "noreply@lane.ru")).toBe(bot)
})
