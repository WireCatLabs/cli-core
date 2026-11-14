import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Chat } from "../domain/models.js"
import type { CacheDatabase } from "./driver.js"
import { openCache } from "./open.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const TG: AccountKey = { provider: "telegram", account: "1" }
const MAIL: AccountKey = { provider: "email", account: "me@acme.ru" }
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
    expect(listed).toMatchObject({ total: 3, hasMore: false })
    expect(listed.counts).toEqual({ person: 3, organization: 0, automated: 0, stranger: 2, unsorted: 0, test: 0 })
    expect((await store.people.list({ limit: 100, kind: "stranger" })).items.map(({ name }) => name)).toEqual([
      "Hugo",
      "Ugo",
    ])
    const everyone = await store.people.list({ limit: 100, kind: "all" })
    expect(everyone.items.find(({ displayName }) => displayName === "Hugo")).toMatchObject({
      ties: [],
      kind: "stranger",
      kindSignals: ["no-tie"],
    })
    expect(everyone.total).toBe(5)
  })

  it("counts mail only when the owner wrote to them, not mail they sent", async () => {
    const { store, db } = await opened()
    await store.accounts.saveAccount(MAIL, { name: null })
    await store.people.savePeople(MAIL, [
      { id: "ann@acme.ru", name: "Ann" },
      { id: "news@shop.ru", name: "Shop News" },
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
    recipient.run(sent, identityPk(db, "email", "ann@acme.ru"), "ann@acme.ru", NOW, NOW)
    const newsletter = Number(
      email.get(account, thread(2), "m2", identityPk(db, "email", "news@shop.ru"), 0, NOW, NOW)?.id,
    )
    recipient.run(newsletter, null, "me@acme.ru", NOW, NOW)

    expect(await shownOf(store)).toEqual({ Ann: ["mail"] })
  })

  it("shows meeting guests, the owner's CRM clients and the address book, and drops someone the book no longer has", async () => {
    const { store, db } = await opened()
    await store.accounts.registerProvider({ name: "bitrix24", kind: "crm", aliases: ["b24"], command: "b24" })
    await store.people.savePeople(CRM, [
      { id: "contact/5", name: "Carla" },
      { id: "contact/6", name: "Cora" },
    ])
    const personPk = (id: string) =>
      Number(
        db
          .prepare(
            "SELECT l.person_id AS p FROM identities i JOIN identity_links l ON l.identity_id = i.id " +
              "WHERE i.provider = 'bitrix24' AND i.external_id = ?",
          )
          .get(id)?.p,
      )
    const owner = Number(db.prepare("SELECT id FROM persons WHERE owner = 1").get()?.id)
    const dealLink = db.prepare(
      "INSERT INTO links (from_type, from_id, to_type, to_id, kind, role, source, created_at, updated_at) " +
        "VALUES ('deal', ?, 'person', ?, 'related-to', ?, 'crm', ?, ?)",
    )
    dealLink.run(1, personPk("contact/5"), "contact", NOW, NOW)
    dealLink.run(1, owner, "owner", NOW, NOW)
    dealLink.run(2, personPk("contact/6"), "contact", NOW, NOW)
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
    expect(Object.keys(await shownOf(store))).not.toContain("Cora")
  })

  it("always shows a person added by hand and anyone assigned a task", async () => {
    const { store } = await opened()
    const people = await named(store, [{ id: "9", name: "Tess" }])
    const added = await store.people.add({ name: "Nora" })
    await store.knowledge.addProject({ name: "Harbour", key: "HRB", type: "work" })
    const task = await store.tasks.create({ project: "HRB", title: "Ship", type: "chore" }, "owner")
    await store.tasks.assign(task.id, { to: people.Tess as string, role: "assignee" }, "owner")

    expect(await shownOf(store)).toMatchObject({ Nora: ["added"], Tess: ["task"] })
    expect(await store.people.ties([people.Tess as string, "person:999999"])).toEqual({
      [people.Tess as string]: ["task"],
      "person:999999": [],
    })
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
    expect(listed.counts.stranger).toBe(0)
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
    await expect(store.people.list({ limit: 10, query: "ab" })).rejects.toMatchObject({
      details: { reason: "query.short-text" },
      message: expect.stringContaining("leave the search out"),
    })
    await expect(store.people.list({ limit: 10, kind: "people" as "person" })).rejects.toThrow(
      "a person's kind is one of",
    )
  })
})

describe("the kind of a person", () => {
  const kinds = async (store: MessageStore) =>
    Object.fromEntries(
      (await store.people.list({ limit: 100, kind: "all" })).items
        .filter(({ owner }) => !owner)
        .map(({ displayName, kind, kindSignals }) => [displayName, [kind, ...kindSignals]]),
    )

  it("puts programs under automated and companies under organization, even with a tie", async () => {
    const { store, db } = await opened()
    await store.people.savePeople(TG, [
      { id: "40", name: "Weather Bot" },
      { id: "41", name: "CZECH AIRLINES" },
      { id: "42", name: "Уведомления Госуслуг" },
      { id: "43", name: "ООО «Ромашка»" },
      { id: "44", name: "Kai" },
    ])
    db.prepare("UPDATE identities SET bot = 1 WHERE external_id = '40'").run()
    await store.chats.saveChats(
      TG,
      ["40", "41", "44"].map((id) => chat(`d${id}`, "dialog", 2)),
    )
    for (const id of ["40", "41", "44"]) await store.roster.saveMembers(TG, `d${id}`, ["1", id])
    await store.accounts.saveAccount(MAIL, { name: null })
    await store.people.savePeople(MAIL, [
      { id: "no-reply@shop.ru", name: "Orders" },
      { id: "info@hotel.ru", name: "Reception" },
      { id: "hr@hotel.ru", name: "Mia Holt" },
    ])

    expect(await kinds(store)).toEqual({
      "Weather Bot": ["automated", "bot"],
      "CZECH AIRLINES": ["organization", "company-name"],
      "Уведомления Госуслуг": ["automated", "automated-name"],
      "ООО «Ромашка»": ["organization", "company-name"],
      Kai: ["person", "chat"],
      Orders: ["automated", "no-reply"],
      Reception: ["organization", "role-address"],
      "Mia Holt": ["stranger", "no-tie"],
    })
  })

  it("calls a sender automated when most of their mail went to the bulk box", async () => {
    const { store, db } = await opened()
    await store.accounts.saveAccount(MAIL, { name: null })
    await store.people.savePeople(MAIL, [{ id: "lena@acme.ru", name: "Lena Marsh" }])
    const account = Number(db.prepare("SELECT id FROM accounts WHERE provider = 'email'").get()?.id)
    const thread = Number(
      db
        .prepare(
          "INSERT INTO email_threads (account_id, external_id, created_at, updated_at) VALUES (?, 't', ?, ?) RETURNING id",
        )
        .get(account, NOW, NOW)?.id,
    )
    const bulk = Number(
      db
        .prepare(
          "INSERT INTO mailboxes (account_id, external_id, name, kind, created_at, updated_at) " +
            "VALUES (?, 'memo:bulk', 'bulk', 'bulk', ?, ?) RETURNING id",
        )
        .get(account, NOW, NOW)?.id,
    )
    for (const n of [1, 2, 3]) {
      const email = Number(
        db
          .prepare(
            "INSERT INTO emails (account_id, email_thread_id, external_id, from_identity_id, outgoing, sent_at, " +
              "created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?) RETURNING id",
          )
          .get(account, thread, `m${n}`, identityPk(db, "email", "lena@acme.ru"), NOW + n, NOW, NOW)?.id,
      )
      db.prepare("INSERT INTO email_mailboxes (email_id, mailbox_id, created_at) VALUES (?, ?, ?)").run(
        email,
        bulk,
        NOW,
      )
    }

    const [lena] = (await store.people.list({ limit: 10, kind: "automated" })).items
    expect(lena).toMatchObject({
      kindSignals: ["bulk-mail"],
      messagesFrom: 3,
      lastContact: new Date(NOW + 3).toISOString(),
      contact: "lena@acme.ru",
    })
  })

  it("keeps someone added by hand a person, and a nameless one unsorted unless a handle names them", async () => {
    const { store, db } = await opened()
    await store.people.add({ name: "Acme LLC" })
    await store.people.savePeople(TG, [
      { id: "50", name: "!" },
      { id: "51", name: "Без имени", username: "kkkslav" },
      { id: "52", name: "Stranger" },
    ])
    await store.chats.saveChats(TG, [chat("d50", "dialog", 2), chat("d51", "dialog", 2)])
    await store.roster.saveMembers(TG, "d50", ["1", "50"])
    await store.roster.saveMembers(TG, "d51", ["1", "51"])
    const organization = Number(
      db
        .prepare(
          "INSERT INTO organizations (kind, name, created_at, updated_at) VALUES ('company', 'Gym', ?, ?) RETURNING id",
        )
        .get(NOW, NOW)?.id,
    )
    await store.people.savePeople(TG, [{ id: "53", name: "Front Desk" }])
    db.prepare(
      "INSERT INTO organization_identities (identity_id, organization_id, method, author, created_at, updated_at) " +
        "VALUES (?, ?, 'manual', 'owner', ?, ?)",
    ).run(identityPk(db, "telegram", "53"), organization, NOW, NOW)

    expect(await kinds(store)).toEqual({
      "Acme LLC": ["person", "added"],
      "!": ["unsorted", "no-name"],
      "@kkkslav": ["person", "chat"],
      Stranger: ["stranger", "no-tie"],
      "Front Desk": ["organization", "organization"],
    })
    expect((await store.people.list({ limit: 1, kind: "unsorted" })).counts).toEqual({
      person: 3,
      organization: 1,
      automated: 0,
      stranger: 1,
      unsorted: 1,
      test: 0,
    })
  })

  it("sorts by the messages people sent, or by the newest contact", async () => {
    const { store, db } = await opened()
    await store.people.savePeople(TG, [
      { id: "60", name: "Quiet" },
      { id: "61", name: "Chatty" },
    ])
    await store.chats.saveChats(TG, [chat("g", "group", 3)])
    await store.roster.saveMembers(TG, "g", ["1", "60", "61"])
    const chatPk = Number(db.prepare("SELECT id FROM chats WHERE external_id = 'g'").get()?.id)
    const account = Number(db.prepare("SELECT id FROM accounts WHERE provider = 'telegram'").get()?.id)
    const message = db.prepare(
      "INSERT INTO messages (chat_id, account_id, external_id, sender_identity_id, sent_at, text, created_at, " +
        "updated_at, source) VALUES (?, ?, ?, ?, ?, 'hi', ?, ?, 'sync')",
    )
    message.run(chatPk, account, "a", identityPk(db, "telegram", "61"), NOW, NOW, NOW)
    message.run(chatPk, account, "b", identityPk(db, "telegram", "61"), NOW + 1, NOW, NOW)
    message.run(chatPk, account, "c", identityPk(db, "telegram", "60"), NOW + 5, NOW, NOW)

    const names = async (sort: "interactions" | "recent") =>
      (await store.people.list({ limit: 10, sort })).items.filter(({ owner }) => !owner).map(({ name }) => name)
    expect(await names("interactions")).toEqual(["Chatty", "Quiet"])
    expect(await names("recent")).toEqual(["Quiet", "Chatty"])
    expect((await store.people.list({ limit: 10 })).items.find(({ name }) => name === "Chatty")).toMatchObject({
      messagesFrom: 2,
      lastContact: new Date(NOW + 1).toISOString(),
    })
  })
})

describe("similar people", () => {
  it("finds names starting like the typed words in any order, the same name first, accents aside", async () => {
    const { store } = await opened()
    await store.people.savePeople(TG, [
      { id: "30", name: "Petrov Ivan" },
      { id: "31", name: "Ivan Petrovsky" },
      { id: "32", name: "Ivana Smith" },
    ])
    await store.people.add({ name: "Iván Petrov" })

    const found = await store.people.similar("ivan PETROV")

    expect(found.map(({ name, sameName }) => [name, sameName])).toEqual([
      ["Iván Petrov", true],
      ["Petrov Ivan", true],
      ["Ivan Petrovsky", false],
    ])
    expect((await store.people.similar("iv")).map(({ name }) => name)).toEqual(
      expect.arrayContaining(["Petrov Ivan", "Ivan Petrovsky", "Ivana Smith"]),
    )
    expect(await store.people.similar("!!")).toEqual([])
  })
})

describe("ё and е in a name", () => {
  it("are one letter to a people search and to the check before adding someone", async () => {
    const { store } = await opened()
    await store.people.savePeople(TG, [
      { id: "30", name: "Пётр Ёлкин" },
      { id: "31", name: "Петр Елкин" },
    ])
    const listed = async (query: string) =>
      (await store.people.list({ limit: 10, kind: "all", query })).items.map(({ displayName }) => displayName).sort()

    expect(await listed("елкин")).toEqual(["Петр Елкин", "Пётр Ёлкин"])
    expect(await listed("Ёлкин")).toEqual(["Петр Елкин", "Пётр Ёлкин"])
    expect((await store.people.similar("Ёлкин")).map(({ displayName }) => displayName).sort()).toEqual([
      "Петр Елкин",
      "Пётр Ёлкин",
    ])
  })
})

describe("a name in another script (BUG-678)", () => {
  it("is found by a people search and by the check before adding someone", async () => {
    const { store } = await opened()
    await store.people.savePeople(MAIL, [{ id: "sveta@acme.ru", name: "Svetlana Kuznetsova" }])
    await store.people.savePeople(TG, [{ id: "20", name: "Светлана Морозова" }])

    const found = await store.people.list({ limit: 10, kind: "all", query: "Светлана" })
    expect(found.items.map(({ displayName }) => displayName).sort()).toEqual([
      "Svetlana Kuznetsova",
      "Светлана Морозова",
    ])
    expect((await store.people.list({ limit: 10, kind: "all", query: "Kuznetsova" })).items).toHaveLength(1)

    expect(
      (await store.people.similar("Светлана Кузнецова")).map(({ displayName, sameName }) => [displayName, sameName]),
    ).toEqual([["Svetlana Kuznetsova", true]])
    expect((await store.people.similar("Светлана")).map(({ displayName }) => displayName).sort()).toEqual([
      "Svetlana Kuznetsova",
      "Светлана Морозова",
    ])
  })
})

describe("a person with no name of their own", () => {
  it("is shown by an account's name, not its username", async () => {
    const { store, db } = await opened()
    await store.people.savePeople(TG, [{ id: "40", name: "Ярослав Орлов", username: "Xorlov" }])
    const uid = (await store.people.personOf({ provider: "telegram", id: "40" }))?.uid
    db.prepare("UPDATE persons SET name = NULL WHERE id = ?").run(Number(uid))

    const row = (await store.people.list({ limit: 10, kind: "all" })).items.find(
      ({ person }) => person === `person:${uid}`,
    )
    expect(row).toMatchObject({ name: null, displayName: "Ярослав Орлов", contact: "@Xorlov" })
  })
})

describe("a username", () => {
  it("names the messenger it belongs to", async () => {
    const { store } = await opened()
    await store.people.savePeople(TG, [{ id: "30", name: "Ola", username: "ola_k" }])

    const row = (await store.people.list({ limit: 10, kind: "all" })).items.find(({ name }) => name === "Ola")
    expect(row).toMatchObject({ contact: "@ola_k", username: "ola_k", usernameSource: "telegram" })
  })
})

describe("a person's shown name (DEBT-311)", () => {
  it("is the same in a person's record as in the list", async () => {
    const { store } = await opened()
    await store.people.savePeople(TG, [
      { id: "30", name: "!", username: "xorlov" },
      { id: "31", name: "null" },
    ])
    await store.people.savePeople(CRM, [{ id: "c/30", name: "Ярослав Орлов" }])
    await store.people.linkIdentities(
      { provider: "telegram", id: "30" },
      { provider: "bitrix24", id: "c/30" },
      { method: "manual", by: "owner" },
    )
    const listed = await store.people.list({ limit: 50, kind: "all" })

    for (const id of ["30", "31"]) {
      const record = await store.people.personOf({ provider: "telegram", id })
      const row = listed.items.find(({ person }) => person === `person:${record?.uid}`)
      expect(record?.displayName).toBe(row?.displayName)
    }
    expect((await store.people.personOf({ provider: "telegram", id: "30" }))?.displayName).toBe("Ярослав Орлов")
  })
})

const WA: AccountKey = { provider: "whatsapp", account: "3" }

const wrote = async (store: MessageStore, account: AccountKey, chat: string, sender: string, count: number) =>
  store.messages.saveMessages(
    account,
    chat,
    Array.from({ length: count }, (_, at) => ({
      ...{ id: `${sender}-${at}`, chatId: chat, senderId: sender, senderName: null, editedAt: null },
      ...{ timestamp: new Date(NOW - (at + 1) * 60_000).toISOString(), text: "synthetic", outgoing: false },
      ...{ attachments: [], replyTo: null, forwardedFrom: null, reactions: null },
    })),
    { via: "history" },
  )

const answered = async (store: MessageStore, account: AccountKey, chat: string) =>
  store.messages.saveMessages(
    account,
    chat,
    [
      {
        ...{ id: "mine", chatId: chat, senderId: null, senderName: null, editedAt: null, outgoing: true },
        ...{ timestamp: new Date(NOW).toISOString(), text: "synthetic", attachments: [], replyTo: null },
        ...{ forwardedFrom: null, reactions: null },
      },
    ],
    { via: "history" },
  )

describe("a person's contact details (the owner's rule, 2026-11-11)", () => {
  it("come from the identity that wrote the most and has each, not from the oldest", async () => {
    const { store } = await opened()
    await store.people.savePeople(MAIL, [
      { id: "kai.old@acme.ru", name: "Kai Berg", email: "kai.old@acme.ru", phone: "+34600000001" },
    ])
    await store.people.savePeople(WA, [{ id: "555@lid", name: "Kai" }])
    await store.people.savePeople(TG, [{ id: "7", name: "Kai", phone: "+34600000002", username: "kai_b" }])
    await store.chats.saveChats(WA, [chat("555@lid", "dialog", 2)])
    await store.chats.saveChats(TG, [chat("7", "dialog", 2)])
    await wrote(store, WA, "555@lid", "555@lid", 30)
    await wrote(store, TG, "7", "7", 3)
    const owner = { method: "manual", by: "owner" }
    await store.people.linkIdentities(
      { provider: "whatsapp", id: "555@lid" },
      { provider: "email", id: "kai.old@acme.ru" },
      owner,
    )
    await store.people.linkIdentities(
      { provider: "telegram", id: "7" },
      { provider: "email", id: "kai.old@acme.ru" },
      owner,
    )

    const [kai] = (await store.people.list({ limit: 100, kind: "all" })).items.filter(({ owner }) => !owner)

    expect(kai).toMatchObject({ phone: "+34600000002", email: "kai.old@acme.ru", username: "kai_b" })
    expect(kai?.messagesFrom).toBe(33)
  })
})

describe("a private conversation", () => {
  it("keeps a person who answers in a private chat out of automated, whatever one mailbox says", async () => {
    const { store, db } = await opened()
    await store.people.savePeople(TG, [{ id: "8", name: "Lu Park" }])
    await store.people.savePeople(MAIL, [{ id: "lu@shop.ru", name: "Lu Park" }])
    await store.people.linkIdentities(
      { provider: "telegram", id: "8" },
      { provider: "email", id: "lu@shop.ru" },
      { method: "manual", by: "owner" },
    )
    const mailbox = identityPk(db, "email", "lu@shop.ru")
    const account = Number(db.prepare("SELECT id FROM accounts WHERE provider = 'email'").get()?.id)
    db.prepare(
      "INSERT INTO account_identities (account_id, identity_id, created_at, updated_at, mail_signals) " +
        "VALUES (?, ?, 0, 0, '[\"bulk_never_replied\"]') ON CONFLICT DO UPDATE SET mail_signals = excluded.mail_signals",
    ).run(account, mailbox)
    const kindOfLu = async () =>
      (await store.people.list({ limit: 100, kind: "all" })).items.find(({ displayName }) => displayName === "Lu Park")
        ?.kind

    expect(await kindOfLu()).toBe("automated")
    await store.chats.saveChats(TG, [chat("8", "dialog", 2)])
    await wrote(store, TG, "8", "8", 2)
    expect(await kindOfLu()).toBe("automated")
    await answered(store, TG, "8")
    expect(await kindOfLu()).toBe("person")
  })
})
