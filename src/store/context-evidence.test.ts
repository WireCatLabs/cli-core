import { afterEach, expect, it, vi } from "vitest"
import type { ContextEvidenceReader, ContextEvidenceRequest } from "../context/evidence.js"
import { createContextEvidenceReader } from "../services/context-evidence.js"
import { contextEvidenceFixture } from "../testing/context-evidence.js"
import { openCache } from "./open.js"
import { contextEvidenceOver } from "./sqlite/context-evidence.js"
import { openStore } from "./store.js"

const present = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error("Missing fixture value")
  return value
}
const handles: { close(): unknown }[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const h of handles.splice(0)) await h.close()
})

const fixture = async (provider = "example-calendar") => {
  const f = await contextEvidenceFixture(provider)
  handles.push(f)
  return f
}

it.each(["example-calendar", "sample-calendar"])(
  "uses the same scoped native reader for %s and preserves pages after reopen",
  async (provider) => {
    const f = await fixture(provider)
    const first = await f.reader.read(f.request)
    expect(first).toMatchObject({
      coverage: { available: true, index: "ready", hasMore: true, completeness: "unknown" },
      items: [{ text: "Harbour launch 3", at: 300, provider }],
      next: { at: 300 },
    })
    expect(first.items[0]?.ref).toBe(`msg:${provider}/AliceExample/planning/3`)
    expect((await f.reader.read({ ...f.request, cursor: present(first.next) })).items[0]?.text).toBe("Harbour launch 2")
    const reopened = await openStore({ path: f.path })
    handles.push(reopened)
    const last = await reopened.contextEvidence?.read({
      ...f.request,
      cursor: { ...present(first.next), at: 200, id: 2 },
    })
    expect(last).toMatchObject({ items: [{ text: "Harbour launch 1" }], next: null, coverage: { hasMore: false } })
  },
)

it("leaves out the messages of a chat the owner hid from search", async () => {
  const f = await fixture()
  f.db.prepare("UPDATE chats SET searchable=0 WHERE account_id=? AND external_id='planning'").run(f.accountId)
  expect(await f.reader.read(f.request)).toMatchObject({ items: [], next: null, coverage: { hasMore: false } })
})

it("reads selected imported documents and mail without internal notes or writes", async () => {
  const f = await fixture()
  await f.store.notes.addNote({ text: "Harbour private comment" })
  f.db.exec("PRAGMA query_only=ON")
  const before = f.db.prepare("SELECT total_changes() AS n").get()
  const docs = await f.reader.read({ ...f.request, source: f.sources.document, before: 10000 })
  expect(docs).toMatchObject({
    items: [{ ref: f.doc.ref, text: "Launch checklist", revision: 1, timeKind: "stored-update" }],
    coverage: { index: "ready" },
  })
  const mail = await f.reader.read({ ...f.request, source: f.sources.mail })
  expect(mail).toMatchObject({
    items: [
      { ref: "msg:email/example-mail/thread/letter", title: "Harbour", text: "Launch agreement", timeKind: "sent" },
    ],
  })
  expect(f.db.prepare("SELECT total_changes() AS n").get()).toEqual(before)
})

it("checks UTF-8 body, title, locator and lookahead bytes before hydrating any row", async () => {
  const f = await fixture()
  const first = await f.reader.read(f.request)
  const spy = vi.spyOn(f.db, "prepare")
  const port = contextEvidenceOver({ database: f.db })
  await expect(port.read({ ...f.request, maxReadBytes: first.readBytes - 1 })).rejects.toMatchObject({
    code: "validation_error",
  })
  expect(spy.mock.calls.some(([sql]) => sql.startsWith("SELECT n.id,n.external_id"))).toBe(false)
  spy.mockRestore()
  expect((await port.read({ ...f.request, maxReadBytes: 262144 })).items).toHaveLength(1)
  const exact = await port.read({ ...f.request, maxReadBytes: first.readBytes })
  expect(exact.items).toHaveLength(1)
  f.db.prepare("UPDATE messages SET text=? WHERE account_id=? AND external_id='2'").run("Ж".repeat(300), f.accountId)
  await expect(port.read({ ...f.request, maxReadBytes: 400 })).rejects.toMatchObject({ code: "validation_error" })
  f.db.prepare("UPDATE chats SET title=? WHERE account_id=?").run("x".repeat(1000), f.accountId)
  await expect(port.read({ ...f.request, maxReadBytes: 900 })).rejects.toMatchObject({ code: "validation_error" })
})

it("reports pending indexes, omits stale matches and keeps source/time boundaries", async () => {
  const f = await fixture()
  const docSource = f.sources.document
  f.db
    .prepare("INSERT OR REPLACE INTO document_index_pending(indexable_type,id) VALUES('document',?)")
    .run(Number(f.doc.id))
  expect(await f.reader.read({ ...f.request, source: docSource, before: 10000 })).toMatchObject({
    items: [],
    coverage: { index: "pending", available: true },
  })
  expect(await f.reader.read({ ...f.request, query: "absent" })).toMatchObject({
    items: [],
    next: null,
    coverage: { completeness: "unknown" },
  })
  expect((await f.reader.read({ ...f.request, after: 200, before: 300 })).items.map((item) => item.at)).toEqual([200])
  expect(await f.reader.read({ ...f.request, after: 201, before: 299 })).toMatchObject({
    items: [],
    coverage: { hasMore: false },
  })
  f.db.prepare("UPDATE emails SET sent_at=NULL WHERE id=1").run()
  expect(await f.reader.read({ ...f.request, source: f.sources.mail })).toMatchObject({
    items: [],
    coverage: { hasUndated: true },
  })
  f.db.exec("DROP TABLE document_words")
  expect(await f.reader.read({ ...f.request, source: docSource })).toMatchObject({
    items: [],
    coverage: { index: "missing" },
  })
})

it("rejects unauthorized selections and changed cursors before database access", async () => {
  const f = await fixture()
  const page = await f.reader.read(f.request)
  const spy = vi.spyOn(f.db, "prepare")
  const port = contextEvidenceOver({ database: f.db })
  const allowed = [{ ...f.sources.message }]
  const reader = createContextEvidenceReader(port, allowed)
  present(allowed[0]).accountId = f.otherId
  for (const patch of [
    { source: { ...f.sources.message, accountId: f.otherId } },
    { query: "different", cursor: present(page.next) },
    { after: 101, cursor: present(page.next) },
  ])
    await expect(reader.read({ ...f.request, ...patch })).rejects.toMatchObject({ code: "validation_error" })
  expect(spy).not.toHaveBeenCalled()
})

it("validates capability, bounds and cancellation before a source read", async () => {
  const read = vi.fn<ContextEvidenceReader["read"]>()
  expect(() =>
    createContextEvidenceReader(undefined as unknown as ContextEvidenceReader, [
      { kind: "mail", accountId: 1, provider: "email", account: "owner" },
    ]),
  ).toThrow(/unavailable/)
  expect(() => createContextEvidenceReader({ read }, [])).toThrow(/allowed/)
  const reader = createContextEvidenceReader({ read }, [
    { kind: "message", accountId: 1, provider: "sample", account: "owner" },
  ])
  const req = {
    source: { kind: "message" as const, accountId: 1, provider: "sample", account: "owner" },
    query: "word",
    after: 0,
    before: 100,
  }
  for (const patch of [
    { limit: 0 },
    { limit: 21 },
    { query: "x".repeat(2049) },
    { source: { ...req.source, provider: "x".repeat(129) } },
    { maxReadBytes: 0 },
    { maxReadBytes: 262145 },
    { before: -1 },
    { query: "?" },
    { query: "w ".repeat(17) },
    { cursor: null },
  ])
    await expect(reader.read({ ...req, ...patch } as ContextEvidenceRequest)).rejects.toMatchObject({
      code: "validation_error",
    })
  await expect(reader.read({ ...req, signal: AbortSignal.abort() })).rejects.toThrow()
  expect(read).not.toHaveBeenCalled()
})

it("refuses missing accounts and a host port returning another source", async () => {
  const f = await fixture()
  expect(await f.port.read({ ...f.request, source: { ...f.sources.message, kind: "mail" } })).toMatchObject({
    coverage: { available: false },
  })
  expect(await f.port.read({ ...f.request, source: { ...f.sources.message, accountId: 999999 } })).toMatchObject({
    coverage: { available: false },
  })
  const page = await f.reader.read(f.request)
  const reader = createContextEvidenceReader(
    { read: async () => ({ ...page, source: { ...page.source, accountId: f.otherId } }) },
    [f.request.source],
  )
  await expect(reader.read(f.request)).rejects.toMatchObject({ code: "invalid_response" })
  const wrongAccount = createContextEvidenceReader(
    { read: async () => ({ ...page, items: page.items.map((item) => ({ ...item, account: "OtherExample" })) }) },
    [f.request.source],
  )
  await expect(wrongAccount.read(f.request)).rejects.toMatchObject({ code: "invalid_response" })
  const controller = new AbortController()
  const cancelled = createContextEvidenceReader(
    {
      read: async () => {
        controller.abort()
        return page
      },
    },
    [f.request.source],
  )
  await expect(cancelled.read({ ...f.request, signal: controller.signal })).rejects.toThrow()
})

it("does not authorize an account whose stored id now names a different external account", async () => {
  const f = await fixture()
  f.db.prepare("UPDATE accounts SET external_id='ReplacementExample' WHERE id=?").run(f.accountId)
  expect(await f.reader.read(f.request)).toMatchObject({ items: [], coverage: { available: false } })
})

it("holds one read snapshot when another connection changes a body after preflight", async () => {
  const f = await fixture()
  const writer = await openCache(f.path)
  handles.push(writer)
  const prepare = f.db.prepare.bind(f.db)
  let changed = false
  vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql)
    if (!sql.startsWith("SELECT coalesce(sum(")) return statement
    return {
      ...statement,
      get: (...args) => {
        const result = statement.get(...args)
        writer
          .prepare(
            "UPDATE messages SET text='Changed after probe',normalized_text='changed after probe',normalizer_version=1,updated_at=6000 WHERE account_id=? AND external_id='3'",
          )
          .run(f.accountId)
        changed = true
        return result
      },
    }
  })
  expect((await f.reader.read(f.request)).items[0]).toMatchObject({ text: "Harbour launch 3", updatedAt: 0 })
  expect(changed).toBe(true)
  expect(writer.prepare("SELECT text FROM messages WHERE account_id=? AND external_id='3'").get(f.accountId)).toEqual({
    text: "Changed after probe",
  })
})

it.each(["probe", "hydrate"])("honors cancellation after %s and leaves no transaction open", async (stage) => {
  const f = await fixture()
  const controller = new AbortController()
  const prepare = f.db.prepare.bind(f.db)
  const spy = vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
    const s = prepare(sql)
    if (stage === "probe" && sql.startsWith("SELECT coalesce(sum("))
      return {
        ...s,
        get: (...args) => {
          const row = s.get(...args)
          controller.abort()
          return row
        },
      }
    if (stage === "hydrate" && sql.startsWith("SELECT n.id,n.external_id"))
      return {
        ...s,
        all: (...args) => {
          const rows = s.all(...args)
          controller.abort()
          return rows
        },
      }
    return s
  })
  await expect(f.reader.read({ ...f.request, signal: controller.signal })).rejects.toThrow()
  spy.mockRestore()
  expect((await f.reader.read(f.request)).items).toHaveLength(1)
})

it("retains unknown or pending message indexing and excludes deleted and inactive sources", async () => {
  const f = await fixture()
  f.db.prepare("UPDATE messages SET normalized_text=NULL WHERE account_id=? AND external_id='3'").run(f.accountId)
  expect(await f.reader.read(f.request)).toMatchObject({ coverage: { index: "pending" } })
  f.db.prepare("DELETE FROM search_index_state WHERE name='message_words'").run()
  expect(await f.reader.read(f.request)).toMatchObject({ coverage: { index: "unknown" } })
  f.db.prepare("UPDATE messages SET deleted_at=1 WHERE account_id=?").run(f.accountId)
  expect((await f.reader.read(f.request)).items).toEqual([])
  f.db.prepare("UPDATE documents SET metadata=? WHERE id=?").run('{"catalog":{"active":false}}', Number(f.doc.id))
  expect((await f.reader.read({ ...f.request, source: f.sources.document, before: 10000 })).items).toEqual([])
})

it("uses remote document modification time when present and never broadens query scope", async () => {
  const f = await fixture()
  f.db
    .prepare("UPDATE documents SET external_updated_at=200,url='https://example.test/source' WHERE id=?")
    .run(Number(f.doc.id))
  expect(await f.reader.read({ ...f.request, source: f.sources.document })).toMatchObject({
    items: [{ at: 200, timeKind: "source-modified", url: "https://example.test/source" }],
  })
  expect((await f.reader.read({ ...f.request, query: "harbour OR scope:c2" })).items).toEqual([])
})

it("projects existing import provenance without hydrating unrelated front matter", async () => {
  const f = await fixture()
  const front = {
    source: "google-drive",
    sourceUrl: "https://example.test/original",
    modifiedAt: "2026-09-01T12:34:56.789Z",
    unused: "x".repeat(100000),
  }
  f.db.prepare("UPDATE documents SET front_matter=? WHERE id=?").run(JSON.stringify(front), Number(f.doc.id))
  const at = Date.parse(front.modifiedAt)
  const page = await f.reader.read({
    ...f.request,
    source: f.sources.document,
    after: at,
    before: at + 1,
    maxReadBytes: 1024,
  })
  expect(page).toMatchObject({ items: [{ at, timeKind: "source-modified", url: front.sourceUrl }] })
  expect(page.readBytes).toBeLessThan(1024)
  for (const metadata of ["not-json", JSON.stringify({ ...front, modifiedAt: "invalid", sourceUrl: 42 })]) {
    f.db.prepare("UPDATE documents SET front_matter=? WHERE id=?").run(metadata, Number(f.doc.id))
    expect(await f.reader.read({ ...f.request, source: f.sources.document, before: 10000 })).toMatchObject({
      items: [{ at: 5000, timeKind: "stored-update", url: null }],
    })
  }
})
