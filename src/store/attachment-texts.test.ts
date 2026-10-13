import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Attachment, Message } from "../domain/models.js"
import { searchStore } from "../services/messages.js"
import { openCache } from "./open.js"
import { resetAttachmentWords } from "./sqlite/attachment-texts.js"
import { type AccountKey, type MessageStore, openStore } from "./store.js"

const OWNER: AccountKey = { provider: "tg", account: "1" }
const fresh = () => join(mkdtempSync(join(tmpdir(), "attachment-texts-")), "messages.db")

const message = (id: string, text: string, attachments: Attachment[]): Message => ({
  id,
  chatId: "-1",
  senderId: "7",
  senderName: "Person 7",
  timestamp: new Date(Date.UTC(2026, 0, 1, 10, Number(id))).toISOString(),
  editedAt: null,
  text,
  outgoing: false,
  attachments,
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})

const raw = async (path: string, sql: string) => {
  const database = await openCache(path)
  try {
    return database
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }))
  } finally {
    database.close()
  }
}

/** Message 1 says "see attached" and carries a file whose text names an invoice; message 2 says "invoice". */
const seeded = async (path = fresh()) => {
  const store = await openStore({ path })
  live.push(store)
  await store.saveMessages(
    OWNER,
    "-1",
    [message("1", "see attached", [{ kind: "file", name: "a.pdf" }]), message("2", "invoice", [])],
    { via: "history" },
  )
  const [file] = await store.fileAttachments(OWNER, { limit: 10 })
  return { store, path, pk: file?.pk as number }
}

const found = async (store: MessageStore, text: string) =>
  (await searchStore(store, OWNER, { text, language: "lucene", limit: 10 })).items.map(({ id }) => id).sort()

describe("text of attachments in the store (version 19)", () => {
  it("**content: finds the message whose file holds the words; text: does not look inside files**", async () => {
    const { store, pk } = await seeded()
    await store.keepAttachmentText(pk, { text: "Счёт за ремонт, invoice 42", origin: "extracted", extractor: "plain" })

    expect(await found(store, "content:invoice")).toEqual(["1"])
    expect(await found(store, "content:счет")).toEqual(["1"])
    expect(await found(store, 'content:"invoice 42"')).toEqual(["1"])
    expect(await found(store, "text:invoice")).toEqual(["2"])
    expect(await found(store, "invoice OR content:invoice")).toEqual(["1", "2"])
    expect(await found(store, "invoice NOT content:invoice")).toEqual(["2"])
    expect(await found(store, "content:missing")).toEqual([])
  })

  it("**an extraction never replaces an agent's text; an agent replaces anything**", async () => {
    const { store, path, pk } = await seeded()
    expect(await store.keepAttachmentText(pk, { text: "scan", origin: "extracted", extractor: "pdf:unpdf@1" })).toBe(
      true,
    )
    expect(await store.keepAttachmentText(pk, { text: "read by eye", origin: "agent", extractor: "agent" })).toBe(true)
    expect(await store.keepAttachmentText(pk, { text: "again", origin: "extracted", extractor: "plain" })).toBe(false)

    expect(await raw(path, "SELECT text, extraction AS origin FROM attachments")).toEqual([
      { text: "read by eye", origin: "agent" },
    ])
    expect(await store.fileAttachments(OWNER, { limit: 10 })).toEqual([])
    expect(await found(store, "content:eye")).toEqual(["1"])
    expect(await found(store, "content:scan")).toEqual([])
  })

  it("**deleting the message erases its files' text and words (NEED-393 A)**", async () => {
    const { store, path, pk } = await seeded()
    await store.keepAttachmentText(pk, { text: "secret contract", origin: "extracted", extractor: "plain" })

    expect(await store.markDeleted(OWNER, ["1"], { chatId: "-1" })).toBe(1)

    expect(await raw(path, "SELECT count(*) AS n FROM attachments WHERE text IS NOT NULL")).toEqual([{ n: 0 }])
    expect(await raw(path, "SELECT count(*) AS n FROM attachment_words WHERE attachment_words MATCH 'secret'")).toEqual(
      [{ n: 0 }],
    )
    expect(await found(store, "content:secret")).toEqual([])
  })

  it("a deleted attachment or message row takes its text with it", async () => {
    const { store, path, pk } = await seeded()
    await store.keepAttachmentText(pk, { text: "words", origin: "extracted", extractor: "plain" })
    await store.close()
    live.splice(0)
    const database = await openCache(path)
    database.exec("PRAGMA foreign_keys = OFF")
    database.exec("DELETE FROM attachments")
    database.close()
    expect(await raw(path, "SELECT count(*) AS n FROM attachments WHERE text IS NOT NULL")).toEqual([{ n: 0 }])

    const again = await seeded()
    await again.store.keepAttachmentText(again.pk, { text: "words", origin: "extracted", extractor: "plain" })
    await again.store.close()
    live.splice(0)
    const other = await openCache(again.path)
    other.exec("PRAGMA foreign_keys = OFF")
    other.exec("DELETE FROM messages")
    other.close()
    expect(await raw(again.path, "SELECT count(*) AS n FROM attachments WHERE text IS NOT NULL")).toEqual([{ n: 0 }])
  })

  it("**`store reindex` rebuilds the files' word index from the kept text**", async () => {
    const { store, path, pk } = await seeded()
    await store.keepAttachmentText(pk, { text: "Ёлка invoice", origin: "extracted", extractor: "plain" })
    await store.close()
    live.splice(0)
    const database = await openCache(path)
    database.exec("UPDATE attachments SET normalized_text = 'stale'")
    database.exec("INSERT INTO attachment_words (attachment_words) VALUES ('delete-all')")
    expect(resetAttachmentWords(database)).toBe(1)
    database.close()

    expect(await raw(path, "SELECT normalized_text FROM attachments WHERE text IS NOT NULL")).toEqual([
      { normalized_text: "елка invoice" },
    ])
    const reopened = await openStore({ path })
    live.push(reopened)
    expect(await found(reopened, "content:елка")).toEqual(["1"])
  })

  it("**`store reindex` gives a voice note the transcript kept before transcripts reached the file index**", async () => {
    const path = fresh()
    const store = await openStore({ path })
    await store.saveMessages(OWNER, "-1", [message("3", "", [{ kind: "voice", mime: "audio/ogg" }])], {
      via: "history",
    })
    await store.keepTranscript(OWNER, "-1", "3", "synthetic heron", "gigaam-v3")
    await store.close()
    const database = await openCache(path)
    database.exec("UPDATE attachments SET text = NULL, normalized_text = NULL, extraction = NULL, extractor = NULL")
    expect(resetAttachmentWords(database)).toBe(1)
    database.close()

    expect(await raw(path, "SELECT text, extractor FROM attachments")).toEqual([
      { text: "synthetic heron", extractor: "speech:gigaam-v3" },
    ])
    const reopened = await openStore({ path })
    live.push(reopened)
    expect(await found(reopened, "content:heron")).toEqual(["3"])
  })
})
