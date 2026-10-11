import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { sampleMeeting } from "../meetings/testing/index.js"
import type { CacheDatabase } from "./driver.js"
import { openCache } from "./open.js"
import { type AccountKey, type MessageStore, openStore, orphanPointers } from "./store.js"

const opened: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close()
})

const MAIL_A: AccountKey = { provider: "email", account: "alice@example.com" }
const MAIL_B: AccountKey = { provider: "email", account: "bob@example.com" }
const TG: AccountKey = { provider: "tg", account: "1" }
const TG_2: AccountKey = { provider: "tg", account: "2" }
const MEET_A: AccountKey = { provider: "example", account: "meet-a" }
const MEET_B: AccountKey = { provider: "example", account: "meet-b" }
const MODEL = "test:model:2"

const tablesWithAccount = (db: CacheDatabase): string[] =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'")
    .all()
    .map(({ name }) => String(name))
    .filter((table) =>
      db
        .prepare(`PRAGMA table_info(${JSON.stringify(table)})`)
        .all()
        .some(({ name }) => name === "account_id"),
    )

/** Rows per table that name an account other than `purged`: what a purge must leave exactly as it was. */
const others = (db: CacheDatabase, purged: number) =>
  Object.fromEntries(
    tablesWithAccount(db).map((table) => [
      table,
      Number(db.prepare(`SELECT count(*) AS n FROM ${JSON.stringify(table)} WHERE account_id IS NOT ?`).get(purged)?.n),
    ]),
  )

const leftovers = (db: CacheDatabase, purged: number) =>
  tablesWithAccount(db).flatMap((table) => {
    const n = Number(
      db.prepare(`SELECT count(*) AS n FROM ${JSON.stringify(table)} WHERE account_id = ?`).get(purged)?.n,
    )
    return n ? [`${table}: ${n}`] : []
  })

const orphanVectors = (db: CacheDatabase) =>
  Number(
    db
      .prepare(
        "SELECT count(*) AS n FROM embeddings v WHERE NOT EXISTS (SELECT 1 FROM chunks k WHERE k.content_hash = v.content_hash)",
      )
      .get()?.n,
  )

const mailOf = async (store: MessageStore, key: AccountKey, text: string) => {
  const accountId = await store.saveAccount(key, { name: null })
  await store.mail.saveThread({
    accountId,
    externalId: "thread-1",
    now: 1000,
    emails: [
      {
        externalId: `<${key.account}>`,
        subject: "Quarterly planning",
        from: { address: "carol@example.com", name: "Carol Example" },
        to: [{ address: key.account, name: null }],
        sentAt: 1000,
        receivedAt: 1000,
        bodyText: text,
        mailboxes: [{ externalId: "INBOX", name: "Inbox", kind: "inbox" }],
        attachments: [
          {
            position: 0,
            kind: "file",
            mime: "text/plain",
            name: "notes.txt",
            title: null,
            url: null,
            size: 10,
            width: null,
            height: null,
            duration: null,
            providerRef: { part: 2 },
            localPath: null,
            text: `${text} attached`,
            normalizedText: null,
            extraction: "text",
            extractor: "plain",
            extractionError: null,
            contentSha256: null,
            extractedAt: 1000,
          },
        ],
      },
    ],
  })
  await store.addTags(key, { type: "chat", chatId: "thread-1" }, ["planning"])
  await store.addTags(key, { type: "message", chatId: "thread-1", messageId: `<${key.account}>` }, ["urgent"])
  return accountId
}

const seeded = async () => {
  const path = join(mkdtempSync(join(tmpdir(), "purge-isolation-")), "store.db")
  const store = await openStore({ path })
  opened.push(store)
  const db = await openCache(path)
  opened.push(db)
  const mailA = await mailOf(store, MAIL_A, "Roadmap for Alice")
  await mailOf(store, MAIL_B, "Roadmap for Bob")
  const pieces = await store.mail.chunksToEmbed(MODEL, { limit: 50 })
  await store.saveVectors(
    MODEL,
    2,
    pieces.map(({ hash }, index) => ({ hash, vector: new Float32Array([index, 1]) })),
  )
  await store.saveChats(TG, [
    { id: "5", title: "Team", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.saveMessages(
    TG,
    "5",
    [
      {
        id: "1",
        chatId: "5",
        senderId: "9",
        senderName: "Carol Example",
        timestamp: new Date(2000).toISOString(),
        editedAt: null,
        text: "the roadmap call",
        outgoing: false,
        attachments: [],
        replyTo: null,
        forwardedFrom: null,
        reactions: null,
      },
    ],
    { via: "history" },
  )
  const meetings: number[] = []
  for (const key of [MEET_A, MEET_B]) {
    const accountId = await store.saveAccount(key, { name: null })
    const input = sampleMeeting()
    input.meeting.accountId = accountId
    await store.meetings.saveMeeting(input)
    meetings.push(accountId)
  }
  return { store, db, mailA, meetA: meetings[0] as number }
}

describe("purging one account", () => {
  it("removes a mail account whole and leaves every other account as it was", async () => {
    const { store, db, mailA } = await seeded()
    const before = others(db, mailA)
    await store.purge(MAIL_A)
    expect(leftovers(db, mailA)).toEqual([])
    expect(others(db, mailA)).toEqual(before)
    expect(orphanPointers(db).filter(({ count }) => count > 0)).toEqual([])
    expect(orphanVectors(db)).toBe(0)
    expect((await store.mail.emails({})).map(({ externalId }) => externalId)).toEqual(["<bob@example.com>"])
    expect((await store.tags(MAIL_B)).map(({ tag }) => tag).sort()).toEqual(["planning", "urgent"])
    expect(await store.people("email", {})).toEqual(expect.objectContaining({ get: expect.any(Function) }))
    expect((await store.people("email", {})).get("carol@example.com")).toBeDefined()
  })

  it("removes a meeting account whole and leaves the other meeting account as it was", async () => {
    const { store, db, meetA } = await seeded()
    const before = others(db, meetA)
    await store.purge(MEET_A)
    expect(leftovers(db, meetA)).toEqual([])
    expect(others(db, meetA)).toEqual(before)
    expect(orphanPointers(db).filter(({ count }) => count > 0)).toEqual([])
    expect(orphanVectors(db)).toBe(0)
  })

  it("removes a messenger account whole and leaves the mail and meeting accounts as they were", async () => {
    const { store, db } = await seeded()
    const tg = Number(db.prepare("SELECT id FROM accounts WHERE provider = 'tg'").get()?.id)
    const before = others(db, tg)
    await store.purge(TG)
    expect(leftovers(db, tg)).toEqual([])
    expect(others(db, tg)).toEqual(before)
    expect(orphanPointers(db).filter(({ count }) => count > 0)).toEqual([])
    expect(orphanVectors(db)).toBe(0)
  })

  it("removes the people only that account had seen, and keeps the tagged and the shared ones", async () => {
    const { store, db } = await seeded()
    await store.saveAccount(TG_2, { name: null })
    await store.savePeople(TG, [
      { id: "21", name: "Dave Example" },
      { id: "22", name: "Erin Example" },
      { id: "23", name: "Carol Example" },
    ])
    await store.savePeople(TG_2, [{ id: "22", name: "Erin Example" }])
    const dave = await store.personOf({ provider: "tg", id: "21" })
    await store.knowledge.addTags(null, { type: "person", id: dave?.uid as string }, ["client"])
    await store.linkIdentities(
      { provider: "tg", id: "23" },
      { provider: "email", id: "carol@example.com" },
      { method: "manual", by: "owner" },
    )
    const carol = await store.personOf({ provider: "tg", id: "9" })
    expect(carol).toBeDefined()
    const persons = Number(db.prepare("SELECT count(*) AS n FROM persons").get()?.n)

    await store.purge(TG)

    const tgIds = db
      .prepare("SELECT external_id AS id FROM identities WHERE provider = 'tg' ORDER BY external_id")
      .all()
      .map(({ id }) => String(id))
    expect(tgIds).toEqual(["21", "22", "23"])
    expect(await store.personOf({ provider: "tg", id: "9" })).toBeUndefined()
    expect(Number(db.prepare("SELECT count(*) AS n FROM persons").get()?.n)).toBe(persons - 1)
    expect((await store.people("email", {})).get("carol@example.com")).toBeDefined()
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([])
    expect(orphanPointers(db).filter(({ count }) => count > 0)).toEqual([])
  })
})
