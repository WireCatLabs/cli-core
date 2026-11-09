import { afterEach, expect, it } from "vitest"
import { accountsMeta } from "../calendar/index.js"
import { ingestVcard } from "../services/ingest.js"
import { personContext } from "../services/person-context.js"
import { searchAll } from "../services/search-all.js"
import { envelopeOf, recordsFixture, SOURCE, take, upsert } from "../testing/records.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const PHONE = { provider: "phone", account: "pixel", batch_id: "2026-11-08" }
const ME = { provider: "telegram", account: "100" }
const ANNA = "+447700900111"
const OLEG = "+447700900333"

const person = (phone: string, name: string) => upsert("person", phone, { name, phone })
const counterpart = (phone: string) => ({ relations: [{ role: "counterpart", type: "person", external_id: phone }] })
const sms = (id: string, phone: string, direction: "in" | "out", body: string, at: string, extra = {}) =>
  upsert("message", id, { kind: "sms", direction, phone, body, sent_at: at, ...extra }, counterpart(phone))
const call = (id: string, phone: string, direction: "in" | "out" | "missed", at: string, duration = 0) =>
  upsert("event", id, { kind: "call", direction, phone, started_at: at, duration }, counterpart(phone))

const phoneEnvelope = (records: unknown[], account = PHONE.account) =>
  envelopeOf(records, { provider: PHONE.provider, account, batch: PHONE.batch_id })

/** A person the store already has by phone, as a messenger contact keeps the number. */
const knownByPhone = (sql: Awaited<ReturnType<typeof recordsFixture>>["sql"], name: string, phone: string) => {
  const db = sql()
  const id = Number(
    db.prepare("INSERT INTO persons (name, created_at, updated_at) VALUES (?, 1, 1) RETURNING id").get(name)?.id,
  )
  const identity = Number(
    db
      .prepare(
        "INSERT INTO identities (provider, external_id, name, phone, created_at, updated_at) " +
          "VALUES ('telegram', '777', ?, ?, 1, 1) RETURNING id",
      )
      .get(name, phone.slice(1))?.id,
  )
  db.prepare(
    "INSERT INTO identity_links (identity_id, person_id, method, confidence, created_at, author, updated_at) " +
      "VALUES (?, ?, 'initial', 1, 1, 'ingest', 1)",
  ).run(identity, id)
  return id
}

const thread = [
  person(ANNA, "Анна Иванова"),
  person(OLEG, "Олег"),
  sms("s-1", ANNA, "in", "Буду в десять, привезу договор", "2026-11-01T09:12:00+01:00", { read: true }),
  sms("s-2", ANNA, "out", "Отлично, жду", "2026-11-01T09:13:30+01:00"),
  sms("s-3", OLEG, "in", "Перезвони по поводу аренды", "2026-11-02T18:00:00Z", { read: false }),
]

it("writes SMS threads both ways as chats of the sms account, the person matched by phone or made", async () => {
  const { store, sql } = await recordsFixture(handles)
  const anna = knownByPhone(sql, "Анна", ANNA)
  const receipt = await take(store, phoneEnvelope(thread), { account: PHONE.account })
  expect(receipt).toMatchObject({ created: 5, refused: 0, waiting: [], unmatched: [], errors: [] })
  const records = await store.records.list({ provider: PHONE.provider, account: PHONE.account, type: "person" })
  expect(records.find((one) => one.externalId === ANNA)).toMatchObject({
    entity: `person:${anna}`,
    createdEntity: false,
  })
  const oleg = records.find((one) => one.externalId === OLEG)
  expect(oleg?.createdEntity).toBe(true)

  const db = sql()
  const chats = db
    .prepare(
      "SELECT c.external_id, c.kind, c.title, c.membership_state FROM chats c JOIN accounts a ON a.id = c.account_id " +
        "WHERE a.provider = 'phone' AND a.external_id = 'pixel' ORDER BY c.external_id",
    )
    .all()
  expect(chats).toEqual([
    { external_id: ANNA, kind: "dialog", title: ANNA, membership_state: "imported" },
    { external_id: OLEG, kind: "dialog", title: OLEG, membership_state: "imported" },
  ])
  const messages = db
    .prepare(
      "SELECT m.external_id, m.outgoing, m.sent_at, m.text, m.metadata, m.source, i.external_id AS sender, " +
        "l.person_id FROM messages m LEFT JOIN identities i ON i.id = m.sender_identity_id " +
        "LEFT JOIN identity_links l ON l.identity_id = i.id ORDER BY m.external_id",
    )
    .all()
  expect(messages).toEqual([
    {
      external_id: "s-1",
      outgoing: 0,
      sent_at: Date.parse("2026-11-01T08:12:00Z"),
      text: "Буду в десять, привезу договор",
      metadata: '{"read":true}',
      source: "import:phone",
      sender: ANNA,
      person_id: anna,
    },
    {
      external_id: "s-2",
      outgoing: 1,
      sent_at: Date.parse("2026-11-01T08:13:30Z"),
      text: "Отлично, жду",
      metadata: null,
      source: "import:phone",
      sender: null,
      person_id: null,
    },
    {
      external_id: "s-3",
      outgoing: 0,
      sent_at: Date.parse("2026-11-02T18:00:00Z"),
      text: "Перезвони по поводу аренды",
      metadata: '{"read":false}',
      source: "import:phone",
      sender: OLEG,
      person_id: Number(oleg?.entity?.slice("person:".length)),
    },
  ])
  const message = await store.records.get({ ...PHONE, type: "message", externalId: "s-1" })
  expect(message?.entity).toBe(`msg:phone/pixel/${encodeURIComponent(ANNA)}/s-1`)
})

it("takes the same export again as unchanged, and a changed text as an edit", async () => {
  const { store, sql } = await recordsFixture(handles)
  await take(store, phoneEnvelope(thread), { account: PHONE.account })
  const again = await take(store, phoneEnvelope(thread), { account: PHONE.account })
  expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 5, errors: [] })
  const edited = sms("s-2", ANNA, "out", "Отлично, жду в 10", "2026-11-01T09:13:30+01:00")
  expect(await take(store, phoneEnvelope([edited]), { account: PHONE.account })).toMatchObject({ updated: 1 })
  const db = sql()
  expect(db.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(3)
  expect(db.prepare("SELECT text FROM message_revisions").all()).toEqual([{ text: "Отлично, жду" }])
  expect(db.prepare("SELECT count(*) AS n FROM persons WHERE owner = 0").get()?.n).toBe(2)
})

it("makes calls, missed ones too, events of the calls calendar that list by person and kind", async () => {
  const { store, sql } = await recordsFixture(handles)
  const receipt = await take(
    store,
    phoneEnvelope([
      person(ANNA, "Анна Иванова"),
      call("c-1", ANNA, "in", "2026-11-03T10:00:00Z", 125),
      call("c-2", ANNA, "missed", "2026-11-03T12:30:00Z"),
      upsert("event", "c-3", { kind: "call", direction: "out", phone: "900", started_at: "2026-11-03T13:00:00Z" }),
    ]),
    { account: PHONE.account },
  )
  expect(receipt).toMatchObject({ created: 4, errors: [], waiting: [] })
  const anna = Number((await store.records.get({ ...PHONE, type: "person", externalId: ANNA }))?.entity?.slice(7))
  const db = sql()
  const rows = db
    .prepare(
      "SELECT e.title, e.description, e.starts_at, e.ends_at, ce.event_type, ce.transparency, ce.metadata, " +
        "c.external_id AS calendar, a.provider FROM events e JOIN calendar_entries ce ON ce.event_id = e.id " +
        "JOIN calendars c ON c.id = ce.calendar_id JOIN accounts a ON a.id = c.account_id ORDER BY e.starts_at",
    )
    .all()
  const start = Date.parse("2026-11-03T10:00:00Z")
  expect(rows).toEqual([
    {
      title: ANNA,
      description: "incoming call",
      starts_at: start,
      ends_at: start + 125_000,
      event_type: "call",
      transparency: "transparent",
      metadata: JSON.stringify({ callDirection: "in", callSeconds: 125, callNumber: ANNA }),
      calendar: "calls",
      provider: "phone",
    },
    expect.objectContaining({ description: "missed call", event_type: "call", ends_at: start + 9_000_000 }),
    expect.objectContaining({ title: "900", description: "outgoing call" }),
  ])
  const accountId = Number(db.prepare("SELECT id FROM accounts WHERE provider = 'phone'").get()?.id)
  const theirs = await store.calendar.events({ personId: anna, from: 0, accountId })
  expect(theirs.map(({ description }) => description)).toEqual(["incoming call", "missed call"])
  expect(await store.calendar.events({ eventType: "call", from: 0 })).toHaveLength(3)
  const meta = await accountsMeta(
    store.calendar,
    [{ id: accountId, key: { provider: "phone", account: "pixel" } }],
    [],
    0,
  )
  expect(meta).toEqual({ accounts: ["phone:pixel"], complete: true })
  expect(
    await take(store, phoneEnvelope([call("c-2", ANNA, "missed", "2026-11-03T12:30:00Z")]), { account: "pixel" }),
  ).toMatchObject({ unchanged: 1 })
})

it("lets search all find SMS among messages and calls among events", async () => {
  const { store } = await recordsFixture(handles)
  await take(store, phoneEnvelope([...thread, call("c-1", OLEG, "in", "2026-11-03T10:00:00Z", 60)]), {
    account: PHONE.account,
  })
  const messages = await searchAll(store, ME, { text: "договор", limit: 10, only: ["messages"], exact: true })
  expect(messages.items.map(({ provider, account, kind }) => [kind, provider, account])).toEqual([
    ["message", "phone", "pixel"],
  ])
  const events = await searchAll(store, ME, { text: "incoming", limit: 10, only: ["events"], exact: true })
  expect(events.items).toHaveLength(1)
  expect(events.items[0]).toMatchObject({ provider: "phone", account: "pixel" })
})

it("waits with the candidates when the number names two people, and never links by name", async () => {
  const { store, sql } = await recordsFixture(handles)
  knownByPhone(sql, "Анна", ANNA)
  const db = sql()
  const other = Number(
    db.prepare("INSERT INTO persons (name, created_at, updated_at) VALUES ('Анна', 1, 1) RETURNING id").get()?.id,
  )
  const identity = Number(
    db
      .prepare(
        "INSERT INTO identities (provider, external_id, phone, created_at, updated_at) VALUES ('phone', ?, ?, 1, 1) RETURNING id",
      )
      .get(ANNA, ANNA)?.id,
  )
  db.prepare(
    "INSERT INTO identity_links (identity_id, person_id, method, confidence, created_at, author, updated_at) " +
      "VALUES (?, ?, 'initial', 1, 1, 'ingest', 1)",
  ).run(identity, other)
  const receipt = await take(
    store,
    phoneEnvelope([
      ...thread.filter((one) => one.external_id !== OLEG && one.external_id !== "s-3"),
      call("c-1", ANNA, "in", "2026-11-03T10:00:00Z", 30),
    ]),
    { account: PHONE.account },
  )
  expect(receipt.unmatched).toEqual([
    expect.objectContaining({ key: `person-${ANNA}`, reason: "record.ambiguous", candidates: expect.any(Array) }),
  ])
  expect(receipt.waiting.map(({ key }) => key)).toEqual(["message-s-1", "message-s-2", "event-c-1"])
  expect(db.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(0)

  await store.records.map({ ...PHONE, type: "person", externalId: ANNA }, `person:${other}`, "owner")
  const linked = db
    .prepare(
      "SELECT DISTINCT l.person_id FROM messages m JOIN identity_links l ON l.identity_id = m.sender_identity_id",
    )
    .all()
  expect(linked).toEqual([{ person_id: other }])
  expect(db.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(2)
  const relations = await store.knowledge.relations(null, `person:${other}`)
  expect(relations).toEqual([
    expect.objectContaining({
      from: (await store.records.get({ ...PHONE, type: "event", externalId: "c-1" }))?.entity,
      to: `person:${other}`,
      kind: "related-to",
      role: "counterpart",
    }),
  ])
})

it("refuses one record whose moment does not exist, and writes the rest", async () => {
  const { store, sql } = await recordsFixture(handles)
  const receipt = await take(
    store,
    phoneEnvelope([
      person(ANNA, "Анна"),
      sms("s-1", ANNA, "in", "ok", "2026-11-01T09:00:00Z"),
      sms("s-2", ANNA, "in", "bad", "2026-13-01T10:00:00Z"),
      call("c-1", ANNA, "in", "2026-11-01T25:00:00Z"),
    ]),
    { account: PHONE.account },
  )
  expect(receipt.errors.map(({ code, key, pointer }) => [code, key, pointer])).toEqual([
    ["record.invalid", "message-s-2", "/records/2/fields/sent_at"],
    ["record.invalid", "event-c-1", "/records/3/fields/started_at"],
  ])
  expect(receipt).toMatchObject({ created: 2, refused: 2 })
  const db = sql()
  expect(db.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(1)
  expect(db.prepare("SELECT count(*) AS n FROM events").get()?.n).toBe(0)
})

it("keeps each phone account apart: the same number and ids in two accounts are two threads", async () => {
  const { store, sql } = await recordsFixture(handles)
  await take(store, phoneEnvelope(thread), { account: "pixel" })
  await take(store, phoneEnvelope(thread, "work-phone"), { account: "work-phone" })
  const db = sql()
  const chats = db
    .prepare(
      "SELECT a.external_id AS account, count(*) AS n FROM chats c JOIN accounts a ON a.id = c.account_id " +
        "WHERE a.provider = 'phone' GROUP BY a.external_id ORDER BY a.external_id",
    )
    .all()
  expect(chats).toEqual([
    { account: "pixel", n: 2 },
    { account: "work-phone", n: 2 },
  ])
  expect(db.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(6)
  const found = await searchAll(store, ME, {
    text: "договор",
    limit: 10,
    only: ["messages"],
    exact: true,
    scope: { messages: [{ provider: "phone", account: "work-phone" }] },
  })
  expect(found.items.map(({ account }) => account)).toEqual(["work-phone"])
})

it("writes nothing on a dry run, and says what a real run would do", async () => {
  const { store, sql } = await recordsFixture(handles)
  const receipt = await take(store, phoneEnvelope([...thread, call("c-1", ANNA, "in", "2026-11-03T10:00:00Z")]), {
    account: PHONE.account,
    dryRun: true,
  })
  expect(receipt).toMatchObject({ dryRun: true, created: 6, errors: [] })
  const db = sql()
  for (const table of ["messages", "chats", "events", "calendars", "records", "identities"])
    expect([table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n]).toEqual([table, 0])
  expect(db.prepare("SELECT count(*) AS n FROM persons WHERE owner = 0").get()?.n).toBe(0)
})

it("refuses an SMS without its kind or with a time that has no offset", async () => {
  const { store } = await recordsFixture(handles)
  const receipt = await take(
    store,
    phoneEnvelope([
      upsert("message", "x-1", { direction: "in", phone: ANNA, body: "a", sent_at: "2026-11-01T09:00:00Z" }),
      upsert("message", "x-2", { kind: "sms", direction: "in", phone: ANNA, body: "a", sent_at: "2026-11-01 09:00" }),
    ]),
    { account: PHONE.account },
  )
  expect(receipt.errors.map(({ code, key }) => [code, key])).toEqual([
    ["record.invalid", "message-x-1"],
    ["record.invalid", "message-x-2"],
  ])
})

const CARDS = [
  "BEGIN:VCARD",
  "VERSION:2.1",
  "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D0=98=D0=B2=D0=B0=D0=BD=D0=BE=D0=B2=D0=B0;=D0=90=D0=BD=D0=BD=D0=B0;;;",
  "TEL;CELL:+44 7700 900111",
  "ORG:ООО Ромашка",
  "TITLE:CTO",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "UID:card-boris",
  "FN:Борис Сидоров",
  "TEL;TYPE=WORK:+44 7700 900555",
  "EMAIL:Boris@Example.com",
  "ORG:ООО Ромашка;Продажи",
  "END:VCARD",
].join("\r\n")

it("imports a vCard file: makes or links persons by number, and one organization they are members of", async () => {
  const { store, sql } = await recordsFixture(handles)
  const anna = knownByPhone(sql, "Анна", ANNA)
  const receipt = await ingestVcard(store, CARDS, { provider: "contacts", account: "pixel", batchId: "b-1" })
  expect(receipt).toMatchObject({ created: 3, errors: [], unmatched: [], vcard: [] })
  const people = await store.records.list({ provider: "contacts", account: "pixel", type: "person" })
  const byName = Object.fromEntries(people.map((one) => [String(one.fields.name), one]))
  expect(byName["Анна Иванова"]).toMatchObject({ entity: `person:${anna}`, createdEntity: false })
  expect(byName["Борис Сидоров"]).toMatchObject({ externalId: "card-boris", createdEntity: true })
  const organizations = await store.records.list({ provider: "contacts", account: "pixel", type: "organization" })
  expect(organizations).toEqual([expect.objectContaining({ externalId: "org:ооо ромашка", createdEntity: true })])
  const relations = byName["Анна Иванова"]?.relations
  expect(relations).toEqual([expect.objectContaining({ role: "member-of", as: "cto", resolved: true })])
  const again = await ingestVcard(store, CARDS, { provider: "contacts", account: "pixel", batchId: "b-2" })
  expect(again).toMatchObject({ created: 0, unchanged: 3 })
  expect(
    (
      await store.records.get({
        ...SOURCE,
        provider: "contacts",
        account: "pixel",
        type: "person",
        externalId: "card-boris",
      })
    )?.entity,
  ).toMatch(/^person:/)
})

it("gives the person's context their SMS dialog and their calls", async () => {
  const { store } = await recordsFixture(handles)
  await take(store, phoneEnvelope([...thread, call("c-1", ANNA, "missed", "2026-11-03T10:00:00Z")]), {
    account: PHONE.account,
  })
  const context = await personContext(store, { provider: "phone", account: "pixel" }, ANNA, {
    now: Date.parse("2026-11-08T00:00:00Z"),
  })
  expect(context.recent.direct.map(({ text }) => text)).toEqual(["Отлично, жду", "Буду в десять, привезу договор"])
  expect(context.events.recent.map(({ ref }) => ref)).toEqual([
    (await store.records.get({ ...PHONE, type: "event", externalId: "c-1" }))?.entity,
  ])
})

it("keeps records, SMS and calls in the one account, which a group naming it once reads for both kinds", async () => {
  const { store, sql } = await recordsFixture(handles)
  await take(store, phoneEnvelope([...thread, call("c-1", OLEG, "in", "2026-11-03T10:00:00Z", 60)]), {
    account: PHONE.account,
  })
  const accounts = sql().prepare("SELECT provider, external_id FROM accounts WHERE provider <> 'internal'").all()
  expect(accounts).toEqual([{ provider: "phone", external_id: "pixel" }])
  await store.accounts.saveAccountGroup("mobile", ["phone:pixel"])
  const found = await searchAll(store, ME, {
    text: "договор OR incoming",
    limit: 10,
    only: ["messages", "events"],
    exact: true,
    source: "group:mobile",
  })
  expect(found.accounts.map(({ resource, provider, account }) => `${resource} ${provider}:${account}`)).toEqual([
    "messages phone:pixel",
    "events phone:pixel",
  ])
  expect(found.items.map(({ kind }) => kind).sort()).toEqual(["event", "message"])
  expect(found.skipped).toEqual([])
})

it("refuses SMS and calls under a provider a messenger or a calendar syncs, or one not import-only", async () => {
  const { store, sql } = await recordsFixture(handles)
  const db = sql()
  const telegram = Number(
    db
      .prepare(
        "INSERT INTO accounts (provider, external_id, scope, created_at, updated_at) VALUES ('telegram', '100', 'personal', 1, 1) RETURNING id",
      )
      .get()?.id,
  )
  db.prepare(
    "INSERT INTO chats (account_id, external_id, kind, title, created_at, updated_at) VALUES (?, '-1001', 'group', 'Family', 1, 1)",
  ).run(telegram)
  const into = (provider: string, account: string, records: unknown[]) =>
    take(store, envelopeOf(records, { provider, account }), { account })
  const toTelegram = await into("telegram", "100", [
    sms("x", ANNA, "in", "hi", "2026-11-01T09:00:00Z", { thread: "-1001" }),
  ])
  const toGoogle = await into("google", "me@example.test", [call("c", ANNA, "in", "2026-11-01T09:00:00Z")])
  const toSheet = await into("sheet", "demo", [call("c", ANNA, "in", "2026-11-01T09:00:00Z")])
  for (const receipt of [toTelegram, toGoogle, toSheet])
    expect(receipt.errors.map(({ code }) => code)).toEqual(["record.provider-not-imported"])
  expect(db.prepare("SELECT kind, title, membership_state FROM chats").all()).toEqual([
    { kind: "group", title: "Family", membership_state: null },
  ])
  for (const table of ["messages", "calendars", "events"])
    expect([table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n]).toEqual([table, 0])
  expect(db.prepare("SELECT count(*) AS n FROM identities WHERE provider = 'telegram'").get()?.n).toBe(0)
})

it("never writes into a chat of the account that an import did not make", async () => {
  const { store, sql } = await recordsFixture(handles)
  await take(store, phoneEnvelope([person(ANNA, "Анна")]), { account: PHONE.account })
  const db = sql()
  const account = Number(db.prepare("SELECT id FROM accounts WHERE provider = 'phone'").get()?.id)
  db.prepare(
    "INSERT INTO chats (account_id, external_id, kind, created_at, updated_at) VALUES (?, 'shared', 'group', 1, 1)",
  ).run(account)
  const receipt = await take(
    store,
    phoneEnvelope([sms("s-1", ANNA, "in", "hi", "2026-11-01T09:00:00Z", { thread: "shared" })]),
    { account: PHONE.account },
  )
  expect(receipt.errors.map(({ code, pointer }) => [code, pointer])).toEqual([
    ["record.chat", "/records/0/fields/thread"],
  ])
})

it("refuses to move an SMS to another thread instead of keeping it twice", async () => {
  const { store, sql } = await recordsFixture(handles)
  await take(store, phoneEnvelope(thread), { account: PHONE.account })
  const moved = sms("s-1", ANNA, "in", "Буду в десять", "2026-11-01T09:12:00+01:00", { thread: "t-9" })
  const receipt = await take(store, phoneEnvelope([moved]), { account: PHONE.account })
  expect(receipt.errors.map(({ code }) => code)).toEqual(["record.moved"])
  const db = sql()
  expect(db.prepare("SELECT count(*) AS n FROM messages WHERE external_id = 's-1'").get()?.n).toBe(1)
  expect(db.prepare("SELECT count(*) AS n FROM chats WHERE external_id = 't-9'").get()?.n).toBe(0)
})

it("tombstones the SMS and the call a deleted record stood for, as a messenger's deleted message is", async () => {
  const { store, sql } = await recordsFixture(handles)
  await take(store, phoneEnvelope([...thread, call("c-1", ANNA, "in", "2026-11-03T10:00:00Z", 30)]), {
    account: PHONE.account,
  })
  const gone = (type: string, id: string) => ({ key: `d-${id}`, type, external_id: id, operation: "delete" })
  const receipt = await take(store, phoneEnvelope([gone("message", "s-1"), gone("event", "c-1")]), {
    account: PHONE.account,
  })
  expect(receipt).toMatchObject({ deleted: 2, flagged: [], errors: [] })
  const db = sql()
  expect(
    db.prepare("SELECT text, deleted_at IS NOT NULL AS gone FROM messages WHERE external_id = 's-1'").get(),
  ).toEqual({
    text: "",
    gone: 1,
  })
  expect(db.prepare("SELECT deleted_at IS NOT NULL AS gone FROM events").get()).toEqual({ gone: 1 })
  const found = await searchAll(store, ME, {
    text: "договор OR incoming",
    limit: 10,
    only: ["messages", "events"],
    exact: true,
  })
  expect(found.items).toEqual([])
})

it("leaves an import-only account out of the coverage a message search reports", async () => {
  const { store } = await recordsFixture(handles)
  await take(store, phoneEnvelope(thread), { account: PHONE.account })
  const found = await searchAll(store, ME, { text: "договор", limit: 5, only: ["messages"], exact: true })
  expect(found.items).toHaveLength(1)
  expect(found.coverage?.chats).toMatchObject({ neverFetched: 0 })
  expect(found.coverage?.attention).toEqual([])
})

it("never writes a call into another account's calendar that took the id a dry run left behind", async () => {
  const { store, sql } = await recordsFixture(handles)
  await take(store, phoneEnvelope([person(ANNA, "Анна"), call("c-1", ANNA, "in", "2026-11-03T10:00:00Z")]), {
    account: PHONE.account,
    dryRun: true,
  })
  const db = sql()
  const google = Number(
    db
      .prepare(
        "INSERT INTO accounts (provider, external_id, scope, created_at, updated_at) VALUES ('google', 'g', 'personal', 1, 1) RETURNING id",
      )
      .get()?.id,
  )
  db.prepare(
    "INSERT INTO calendars (account_id, external_id, title, access_role, primary_calendar, synced, created_at, updated_at) " +
      "VALUES (?, 'g', 'Work', 'owner', 1, 1, 1, 1)",
  ).run(google)
  const receipt = await take(
    store,
    phoneEnvelope([person(ANNA, "Анна"), call("c-1", ANNA, "in", "2026-11-03T10:00:00Z")]),
    {
      account: PHONE.account,
    },
  )
  expect(receipt).toMatchObject({ errors: [], waiting: [] })
  expect(
    db
      .prepare(
        "SELECT c.external_id AS calendar, a.provider FROM calendar_entries ce JOIN calendars c ON c.id = ce.calendar_id " +
          "JOIN accounts a ON a.id = c.account_id",
      )
      .all(),
  ).toEqual([{ calendar: "calls", provider: "phone" }])
})

it("brings an SMS and a call back when their deleted records are sent again", async () => {
  const { store, sql } = await recordsFixture(handles)
  const sent = [...thread, call("c-1", ANNA, "in", "2026-11-03T10:00:00Z", 30)]
  await take(store, phoneEnvelope(sent), { account: PHONE.account })
  const gone = (type: string, id: string) => ({ key: `d-${id}`, type, external_id: id, operation: "delete" })
  await take(store, phoneEnvelope([gone("message", "s-1"), gone("event", "c-1")]), { account: PHONE.account })
  const back = await take(store, phoneEnvelope(sent), { account: PHONE.account })
  expect(back).toMatchObject({ updated: 2, errors: [], flagged: [] })
  const db = sql()
  expect(db.prepare("SELECT text, deleted_at FROM messages WHERE external_id = 's-1'").get()).toEqual({
    text: "Буду в десять, привезу договор",
    deleted_at: null,
  })
  expect(db.prepare("SELECT deleted_at, status FROM events").get()).toEqual({ deleted_at: null, status: "confirmed" })
  const found = await searchAll(store, ME, {
    text: "договор OR incoming",
    limit: 10,
    only: ["messages", "events"],
    exact: true,
  })
  expect(found.items.map(({ kind }) => kind).sort()).toEqual(["event", "message"])
})
