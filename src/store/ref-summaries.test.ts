import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { CacheDatabase } from "./driver.js"
import { openCache } from "./open.js"
import { refSummariesOf } from "./sqlite/ref-summaries.js"
import { type MessageStore, openStore } from "./store.js"

const BODY = "the secret body of a message"
const AT = Date.UTC(2026, 9, 19, 14, 20)

const SEED = [
  "INSERT INTO accounts (id, provider, external_id, name, created_at, updated_at) VALUES " +
    "(11, 'max', '34871122', 'Main', 0, 0), (12, 'email', 'owner@example.com', NULL, 0, 0), " +
    "(13, 'google-drive', 'owner@example.com', 'Drive', 0, 0), (14, 'local', 'vault', 'Vault', 0, 0), " +
    "(15, 'zoom', 'zoom-1', 'Zoom work', 0, 0), (16, 'google-calendar', 'cal-1', NULL, 0, 0)",
  "INSERT INTO chats (id, account_id, external_id, kind, title, created_at, updated_at) VALUES " +
    "(21, 11, '63488582', 'group', 'Сайт + автоматизация', 0, 0)",
  "INSERT INTO identities (id, provider, external_id, name, username, created_at, updated_at) VALUES " +
    "(31, 'max', '77', 'Ana Example', NULL, 0, 0), (32, 'max', '78', NULL, 'kai', 0, 0)",
  "INSERT INTO messages (id, chat_id, account_id, external_id, sender_identity_id, sent_at, text, created_at, " +
    `source, updated_at, deleted_at) VALUES (41, 21, 11, '10', 31, ${AT}, '${BODY}', 0, 'sync', 0, NULL), ` +
    `(42, 21, 11, '11', 31, ${AT}, 'gone', 0, 'sync', 0, 5)`,
  "INSERT INTO email_threads (id, account_id, external_id, subject, last_email_at, created_at, updated_at) VALUES " +
    `(51, 12, 't1', 'Invoice', ${AT}, 0, 0)`,
  "INSERT INTO emails (id, account_id, email_thread_id, external_id, subject, from_name, sent_at, body_text, " +
    `created_at, updated_at) VALUES (52, 12, 51, 'e1', 'Invoice March', 'Bob Sample', ${AT}, 'mail body', 0, 0)`,
  "INSERT INTO persons (id, name, owner, created_at, updated_at) VALUES (61, 'Lena Example', 0, 0, 0)",
  "INSERT INTO organizations (id, kind, name, created_at, updated_at) VALUES (62, 'company', 'Example Ltd', 0, 0)",
  "INSERT INTO projects (id, key, name, type, created_at, updated_at) VALUES (63, 'DEMO', 'DemoRent', 'work', 0, 0)",
  "INSERT INTO tasks (id, project_id, number, key, title, type, status, author_type, author_id, source, due_at, " +
    `created_at, updated_at) VALUES (64, 63, 1, 'DEMO-1', 'Ship the catalog', 'task', 'open', 'bot', 1, 'cli', ${AT}, 0, 0)`,
  "INSERT INTO notes (id, notable_type, notable_id, title, body, created_at, updated_at, deleted_at) VALUES " +
    `(71, 'project', 63, 'Call notes', 'note body', 0, ${AT}, NULL), (72, 'project', 63, 'Old', 'x', 0, 0, 9)`,
  "INSERT INTO documents (id, account_id, external_id, kind, title, body, external_updated_at, created_at, " +
    `updated_at) VALUES (81, 13, 'g1', 'document', 'Задачи SEO Example', 'document body', ${AT}, 0, 0)`,
  "INSERT INTO memories (id, kind, body, subject_type, subject_id, author_type, author_id, status, scope, " +
    `created_at, updated_at) VALUES (91, 'summary', '${"Lena prefers Friday calls. ".repeat(10)}', 'person', 61, ` +
    `'bot', 1, 'active', 'work', ${AT}, 0)`,
  "INSERT INTO facts (id, type, statement, status, subject_type, subject_id, author_type, author_id, source, " +
    `created_at, updated_at) VALUES (92, 'decision', 'The launch is in March', 'accepted', 'project', 63, 'bot', 1, ` +
    `'agent', ${AT}, 0)`,
  "INSERT INTO meetings (id, account_id, external_id, title, description, started_at, created_at, updated_at) " +
    `VALUES (101, 15, 'm1', 'Weekly sync', 'agenda', ${AT}, 0, 0)`,
  "INSERT INTO meeting_transcripts (id, meeting_id, source, created_at, updated_at) VALUES (102, 101, 'zoom', 0, 0)",
  "INSERT INTO meeting_transcript_rows (id, meeting_transcript_id, position, start_ms, end_ms, speaker_name, text, " +
    "created_at) VALUES (103, 102, 0, 60000, 61000, 'Ana', 'spoken words', 0)",
  `INSERT INTO events (id, title, starts_at, origin, created_at, updated_at) VALUES (111, 'Launch call', ${AT}, 'sync', 0, 0)`,
  "INSERT INTO calendars (id, account_id, external_id, title, primary_calendar, synced, created_at, updated_at) " +
    "VALUES (112, 16, 'c1', 'Work calendar', 1, 1, 0, 0)",
  "INSERT INTO calendar_entries (calendar_id, kind, external_id, exception, status, all_day, event_id, created_at, " +
    "updated_at) VALUES (112, 'event', 'ce1', 0, 'confirmed', 0, 111, 0, 0)",
]

const live: (MessageStore | CacheDatabase)[] = []
afterEach(async () => {
  for (const one of live.splice(0)) await one.close()
})

const fixture = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ref-summaries-")), "store.db")
  const store = await openStore({ path })
  live.push(store)
  const database = await openCache(path)
  live.push(database)
  for (const statement of SEED) database.exec(statement)
  let statements = 0
  const counted: CacheDatabase = {
    exec: (sql) => database.exec(sql),
    prepare: (sql) => {
      statements += 1
      return database.prepare(sql)
    },
    close: () => undefined,
  }
  return { store, database: counted, statements: () => statements }
}

const iso = new Date(AT).toISOString()

describe("store.refs.summaries", () => {
  it("names every kind the store holds, with what holds it and when", async () => {
    const { store } = await fixture()
    const refs = [
      "chat:max/34871122/63488582",
      "msg:max/34871122/63488582/10",
      "contact:max/77",
      "contact:max/78",
      "chat:email/owner%40example.com/t1",
      "msg:email/owner%40example.com/t1/e1",
      "person:61",
      "organization:62",
      "project:63",
      "task:DEMO-1",
      "note:71",
      "document:81",
      "memory:91",
      "fact:92",
      "meeting:15/101",
      "meeting:15/101/102/0",
      "event:111",
      "folder:14/plans",
      "bot:2",
    ]
    const summaries = await store.refs.summaries(refs)
    expect([...summaries.keys()]).toEqual(refs)
    const row = (ref: string) => {
      const { kind, title, in: holder, at, provider, tool, state } = summaries.get(ref) ?? {}
      return [kind, title, holder, at, provider, tool, state]
    }
    expect(refs.map(row)).toEqual([
      ["chat", "Сайт + автоматизация", "MAX", iso, "max", "max", "available"],
      ["message", "Ana Example · 2026-10-19 14:20", "Сайт + автоматизация", iso, "max", "max", "available"],
      ["contact", "Ana Example", "MAX", null, "max", "max", "available"],
      ["contact", "@kai", "MAX", null, "max", "max", "available"],
      ["email_thread", "Invoice", "owner@example.com", iso, "email", null, "available"],
      ["email", "Invoice March", "Bob Sample", iso, "email", null, "available"],
      ["person", "Lena Example", null, null, null, null, "available"],
      ["organization", "Example Ltd", null, null, null, null, "available"],
      ["project", "DEMO · DemoRent", null, null, null, null, "available"],
      ["task", "DEMO-1 · Ship the catalog", "DemoRent", iso, null, null, "available"],
      ["note", "Call notes", "DemoRent", iso, "notes", null, "available"],
      ["document", "Задачи SEO Example", "Google Drive", iso, "google-drive", null, "available"],
      [
        "memory",
        expect.stringMatching(/^Lena prefers Friday calls\. .{40,}…$/),
        "Lena Example",
        iso,
        null,
        null,
        "available",
      ],
      ["fact", "The launch is in March", "DemoRent", iso, null, null, "available"],
      ["meeting", "Weekly sync", "Zoom work", iso, "zoom", null, "available"],
      ["meeting", "Weekly sync", "Zoom work", new Date(AT + 60000).toISOString(), "zoom", null, "available"],
      ["event", "Launch call", "Work calendar", iso, "google-calendar", null, "available"],
      ["folder", "Vault/plans", null, null, "local", null, "available"],
      ["bot", "agent", null, null, null, null, "available"],
    ])
    expect(summaries.get("memory:91")?.title?.length).toBe(80)
    expect(summaries.get("msg:max/34871122/63488582/10")).toMatchObject({ account: "34871122" })
  })

  it("reads 100 refs of 4 kinds in 4 statements, keyed by the text passed and in its order", async () => {
    const { database, statements } = await fixture()
    const refs = Array.from({ length: 25 }, (_, at) => [
      `note:${at === 0 ? 71 : 1000 + at}`,
      `chat:max/34871122/${at === 0 ? "63488582" : at}`,
      `document:${at === 0 ? 81 : 2000 + at}`,
      ` msg:max/34871122/63488582/${at === 0 ? 10 : 500 + at}`,
    ]).flat()
    const summaries = refSummariesOf(database, refs)
    expect(statements()).toBe(4)
    expect([...summaries.keys()]).toEqual(refs)
    expect(summaries.get(" msg:max/34871122/63488582/10")).toMatchObject({
      ref: "msg:max/34871122/63488582/10",
      state: "available",
    })
    expect(summaries.get("note:1001")).toMatchObject({ kind: "note", title: null, state: "unavailable" })
  })

  it("never throws for a bad ref, and says deleted, unavailable or unknown", async () => {
    const { store } = await fixture()
    const summaries = await store.refs.summaries([
      "note:72",
      "msg:max/34871122/63488582/11",
      "chat:max/34871122",
      "doc:413",
      "Note: plan",
      "entity:5",
      "note:abc",
      "chat:telegram/1/2",
    ])
    expect([...summaries.values()].map(({ ref, kind, title, state }) => [ref, kind, title, state])).toEqual([
      ["note:72", "note", "Old", "deleted"],
      ["msg:max/34871122/63488582/11", "message", "Ana Example · 2026-10-19 14:20", "deleted"],
      ["chat:max/34871122", "unknown", null, "unavailable"],
      ["doc:413", "unknown", null, "unavailable"],
      ["Note: plan", "unknown", null, "unavailable"],
      ["entity:5", "unknown", null, "unavailable"],
      ["note:abc", "note", null, "unavailable"],
      ["chat:telegram/1/2", "chat", null, "unavailable"],
    ])
    expect(summaries.get("chat:telegram/1/2")).toMatchObject({ provider: "telegram", account: "1", tool: "tg" })
  })

  it("keeps message, mail and transcript text out unless an excerpt is asked for, and then at most 280 characters", async () => {
    const { store, database } = await fixture()
    database.exec(`UPDATE documents SET body = '${"long ".repeat(200)}' WHERE id = 81`)
    const refs = [
      "msg:max/34871122/63488582/10",
      "msg:email/owner%40example.com/t1/e1",
      "meeting:15/101/102/0",
      "document:81",
    ]
    const plain = await store.refs.summaries(refs)
    expect(JSON.stringify([...plain.values()])).not.toMatch(/secret body|mail body|spoken words|long long/)
    for (const summary of plain.values()) expect(summary).not.toHaveProperty("excerpt")

    const excerpted = await store.refs.summaries([...refs, "msg:max/34871122/63488582/11"], { excerpt: true })
    expect([...excerpted.values()].map(({ excerpt }) => excerpt?.slice(0, 12) ?? null)).toEqual([
      BODY.slice(0, 12),
      "mail body",
      "spoken words",
      "long long lo",
      null,
    ])
    expect(excerpted.get("document:81")?.excerpt).toHaveLength(280)
  })

  it("reads mail the store kept as messages, before the mail tables, as a message", async () => {
    const { store, database } = await fixture()
    database.exec(
      "INSERT INTO chats (id, account_id, external_id, kind, title, created_at, updated_at) VALUES " +
        "(23, 12, 'old-thread', 'private', 'Old mail', 0, 0)",
    )
    database.exec(
      "INSERT INTO messages (id, chat_id, account_id, external_id, sender_name, sent_at, text, created_at, source, " +
        `updated_at) VALUES (43, 23, 12, 'old-1', 'Bob Sample', ${AT}, 'old body', 0, 'sync', 0)`,
    )
    const summaries = await store.refs.summaries([
      "msg:email/owner%40example.com/old-thread/old-1",
      "chat:email/owner%40example.com/old-thread",
    ])
    expect([...summaries.values()].map(({ kind, title, state }) => [kind, title, state])).toEqual([
      ["message", "Bob Sample · 2026-10-19 14:20", "available"],
      ["chat", "Old mail", "available"],
    ])
  })
})
