import { afterEach, describe, expect, it } from "vitest"
import { searchNotesOf } from "../services/notes-search.js"
import { searchAll } from "../services/search-all.js"
import { envelopeOf, recordsFixture, take, upsert } from "../testing/records.js"

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const ME = { provider: "telegram", account: "100" }
const ANNA = "+447700900111"
const BATCH = "2026-11-13"

const document = (id: string, text: string, extra: Record<string, unknown> = {}, relations = {}) =>
  upsert("document", id, { title: `Transcript ${id}`, text, ...extra }, relations)

const pbx = (records: unknown[]) => envelopeOf(records, { provider: "phone", account: "office-pbx", batch: BATCH })
const notes = (records: unknown[]) => envelopeOf(records, { provider: "import", account: "crm-notes", batch: BATCH })

const rowsOf = (sql: Awaited<ReturnType<typeof recordsFixture>>["sql"]) =>
  sql()
    .prepare(
      "SELECT a.provider, a.external_id AS account, d.external_id, d.title, d.body, d.url, d.revision, " +
        "d.external_created_at, d.external_updated_at, d.deleted_at IS NOT NULL AS deleted FROM documents d " +
        "JOIN accounts a ON a.id = d.account_id ORDER BY d.id",
    )
    .all()

describe("a document record", () => {
  it("is a document of the envelope's own account, keyed by its external id and revised when its text changes", async () => {
    const { store, sql } = await recordsFixture(handles)
    const first = document("calls/2026-11-01 anna.txt", "Anna asked about the lease renewal", {
      created_at: "2026-11-01T09:00:00Z",
      updated_at: "2026-11-01T09:30:00Z",
      url: "https://pbx.example.org/calls/1",
      metadata: { duration: 120 },
    })
    expect(await take(store, pbx([first]), { account: "office-pbx" })).toMatchObject({ created: 1, errors: [] })
    expect(rowsOf(sql)).toEqual([
      {
        provider: "phone",
        account: "office-pbx",
        external_id: "calls/2026-11-01 anna.txt",
        title: "Transcript calls/2026-11-01 anna.txt",
        body: "Anna asked about the lease renewal",
        url: "https://pbx.example.org/calls/1",
        revision: 1,
        external_created_at: Date.parse("2026-11-01T09:00:00Z"),
        external_updated_at: Date.parse("2026-11-01T09:30:00Z"),
        deleted: 0,
      },
    ])
    const record = await store.records.get({
      provider: "phone",
      account: "office-pbx",
      type: "document",
      externalId: "calls/2026-11-01 anna.txt",
    })
    expect(record?.entity).toMatch(/^document:\d+$/)
    expect(record?.fields.metadata).toEqual({ duration: 120 })

    expect(await take(store, pbx([first]), { account: "office-pbx" })).toMatchObject({ unchanged: 1, created: 0 })
    expect(rowsOf(sql)).toHaveLength(1)

    const edited = { ...first, fields: { ...first.fields, text: "Anna renews the lease for a year" } }
    expect(await take(store, pbx([edited]), { account: "office-pbx" })).toMatchObject({ updated: 1 })
    expect(rowsOf(sql)).toMatchObject([{ body: "Anna renews the lease for a year", revision: 2, deleted: 0 }])
    const retitled = { ...edited, fields: { ...edited.fields, title: "Anna, lease" } }
    await take(store, pbx([retitled]), { account: "office-pbx" })
    expect(rowsOf(sql)).toMatchObject([{ title: "Anna, lease", revision: 2 }])

    const gone = { key: "d", type: "document", external_id: "calls/2026-11-01 anna.txt", operation: "delete" }
    expect(await take(store, pbx([gone]), { account: "office-pbx" })).toMatchObject({ deleted: 1 })
    expect(rowsOf(sql)).toMatchObject([{ body: "", deleted: 1 }])

    await take(store, pbx([retitled]), { account: "office-pbx" })
    expect(rowsOf(sql)).toMatchObject([{ body: "Anna renews the lease for a year", deleted: 0 }])
  })

  it("is taken only under an import-only provider, the seeded import among them", async () => {
    const { store, sql } = await recordsFixture(handles)
    const refused = await take(store, envelopeOf([document("n-1", "a note")]), { account: "demo-rent" })
    expect(refused.errors).toMatchObject([{ code: "record.provider-not-imported" }])
    expect(await take(store, notes([document("n-1", "a note")]), { account: "crm-notes" })).toMatchObject({
      created: 1,
    })
    expect(rowsOf(sql)).toMatchObject([{ provider: "import", account: "crm-notes", body: "a note" }])
  })

  it("is linked about the call and the person it names", async () => {
    const { store, sql } = await recordsFixture(handles)
    const receipt = await take(
      store,
      pbx([
        upsert("person", ANNA, { name: "Anna", phone: ANNA }),
        upsert("event", "c-1", { kind: "call", direction: "in", phone: ANNA, started_at: "2026-11-01T09:00:00Z" }),
        document(
          "t-1",
          "the lease",
          {},
          {
            relations: [
              { role: "about", type: "event", external_id: "c-1" },
              { role: "about", type: "person", external_id: ANNA },
            ],
          },
        ),
      ]),
      { account: "office-pbx" },
    )
    expect(receipt).toMatchObject({ created: 3, errors: [], waiting: [] })
    const links = sql()
      .prepare(
        "SELECT l.to_type, l.source, l.confirmed FROM links l JOIN documents d ON d.id = l.from_id " +
          "WHERE l.from_type = 'document' ORDER BY l.to_type",
      )
      .all()
    expect(links).toEqual([
      { to_type: "event", source: "import", confirmed: 1 },
      { to_type: "person", source: "import", confirmed: 1 },
    ])
  })

  it("queues a phone number in its text for mentions", async () => {
    const { store } = await recordsFixture(handles)
    await take(store, pbx([document("t-1", "Call back on +44 7700 900222 about the lease")]), {
      account: "office-pbx",
    })
    await store.mentions.rebuildMentions()
    const listed = await store.sourceMentions.list("document", undefined, { offset: 0 }, [])
    expect(listed.items.map(({ kind, value }) => `${kind} ${value}`)).toEqual(["phone +447700900222"])
  })
})

describe("search over an import-only account's documents", () => {
  const seeded = async () => {
    const { store } = await recordsFixture(handles)
    await take(
      store,
      pbx([
        upsert("message", "s-1", {
          kind: "sms",
          direction: "in",
          phone: ANNA,
          body: "the lease papers are ready",
          sent_at: "2026-11-01T08:00:00Z",
        }),
        document("t-1", "Anna renews the lease for a year", {
          updated_at: "2026-10-06T12:00:00Z",
          url: "https://pbx.example.org/calls/1",
        }),
      ]),
      { account: "office-pbx" },
    )
    await take(store, notes([document("n-1", "the lease of the second flat")]), { account: "crm-notes" })
    return store
  }

  it("finds them by notes search, under their own account, and only that account's with --source", async () => {
    const store = await seeded()
    const all = await searchNotesOf(store, ME, "lease", { limit: 10 })
    expect(all.items.map(({ kind, provider, account }) => `${kind} ${provider}:${account}`).sort()).toEqual([
      "document import:crm-notes",
      "document phone:office-pbx",
    ])
    const one = await searchNotesOf(store, ME, "lease", { accounts: "phone:office-pbx", limit: 10 })
    expect(one.items.map(({ title }) => title)).toEqual(["Transcript t-1"])
    expect(one.accounts).toEqual([{ resource: "notes", provider: "phone", account: "office-pbx" }])
    expect(one.skipped).toEqual([])
    expect(one.items[0]?.url).toBe("https://pbx.example.org/calls/1")
    const dated = await searchNotesOf(store, ME, "lease date:2026-10-06", { limit: 10 })
    expect(dated.items.map(({ title }) => title)).toEqual(["Transcript t-1"])
  })

  it("finds them in search all, and the account's SMS still under its own name", async () => {
    const store = await seeded()
    const found = await searchAll(store, ME, { text: "lease", limit: 10, exact: true })
    expect(found.items.map(({ kind, provider, account }) => `${kind} ${provider}:${account}`).sort()).toEqual([
      "document import:crm-notes",
      "document phone:office-pbx",
      "message phone:office-pbx",
    ])
    const scoped = await searchAll(store, ME, { text: "lease", limit: 10, exact: true, source: "phone:office-pbx" })
    expect(scoped.items.map(({ kind, provider, account }) => `${kind} ${provider}:${account}`).sort()).toEqual([
      "document phone:office-pbx",
      "message phone:office-pbx",
    ])
  })
})
