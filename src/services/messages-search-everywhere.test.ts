import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Attachment, Message } from "../domain/models.js"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
import { searchStore } from "./messages-archive-search.js"

const account: AccountKey = { provider: "telegram", account: "100" }
const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})

const message = (id: string, text: string, attachments: Attachment[] = []): Message => ({
  id,
  chatId: "1",
  senderId: "200",
  senderName: "alice",
  timestamp: new Date(Date.UTC(2026, 0, 1, 10, Number(id))).toISOString(),
  editedAt: null,
  text,
  outgoing: false,
  attachments,
  replyTo: null,
  forwardedFrom: null,
  reactions: null,
})

/**
 * 1: says "heron" in its text. 2: a voice note whose transcript says it. 3: a spreadsheet whose text says it.
 * 4: a file named after it. 5: unrelated.
 */
const seeded = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "everywhere-")), "messages.db") })
  live.push(store)
  await store.saveChats(account, [
    { id: "1", title: "Chat", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
  ])
  await store.saveMessages(
    account,
    "1",
    [
      message("1", "the heron is back"),
      message("2", "", [{ kind: "voice", mime: "audio/ogg" }]),
      message("3", "see the table", [{ kind: "document", name: "budget.xlsx" }]),
      message("4", "", [{ kind: "document", name: "Heron census 2026.pdf" }]),
      message("5", "nothing here"),
    ],
    { via: "history" },
  )
  await store.keepTranscript(account, "1", "2", "a heron landed by the river", "gigaam-v3")
  const sheet = (await store.fileAttachments(account, { limit: 10 })).find(({ messageId }) => messageId === "3")
  await store.keepAttachmentText(sheet?.pk as number, {
    text: "# Birds\nRow 2: Bird: heron; Count: 42",
    origin: "extracted",
    extractor: "document:v2:xlsx",
  })
  return store
}

const search = (store: MessageStore, text: string, extra: Partial<Parameters<typeof searchStore>[2]> = {}) =>
  searchStore(store, account, { limit: 20, text, language: "lucene", ...extra })
const ids = (found: { items: { id: string }[] }) => found.items.map(({ id }) => id).sort()

describe("a plain word searches everywhere", () => {
  it("**finds it in message text, a transcript, file text and a file name**, and says where", async () => {
    const store = await seeded()
    const found = await search(store, "heron")

    expect(ids(found)).toEqual(["1", "2", "3", "4"])
    const where = Object.fromEntries(found.items.map((hit) => [hit.id, hit.matchedIn]))
    expect(where).toEqual({ "1": "text", "2": "transcript", "3": "file", "4": "filename" })
    const excerpts = Object.fromEntries(found.items.map((hit) => [hit.id, hit.excerpt]))
    expect(excerpts["2"]).toBe("a heron landed by the river")
    expect(excerpts["3"]).toContain("Bird: heron")
    expect(excerpts["4"]).toBe("Heron census 2026.pdf")
  })

  it("does so under --exact too", async () => {
    const store = await seeded()
    expect(ids(await search(store, "heron", { exact: true }))).toEqual(["1", "2", "3", "4"])
  })

  it("**narrows with text:, transcript:, content: and filename:**", async () => {
    const store = await seeded()
    expect(ids(await search(store, "text:heron"))).toEqual(["1"])
    expect(ids(await search(store, "transcript:heron"))).toEqual(["2"])
    expect(ids(await search(store, "content:heron"))).toEqual(["3"])
    expect(ids(await search(store, 'filename:"heron census 2026.pdf"'))).toEqual(["4"])
    expect(ids(await search(store, "filename:heron* OR content:heron"))).toEqual(["3", "4"])
  })

  it("keeps Boolean logic over every place a word can be", async () => {
    const store = await seeded()
    expect(ids(await search(store, "heron AND table"))).toEqual(["3"])
    expect(ids(await search(store, "river OR census"))).toEqual(["2", "4"])
    expect(ids(await search(store, "chat:1 AND NOT heron"))).toEqual(["5"])
  })

  it("finds a Russian file name whatever its case, й and ё", async () => {
    const store = await seeded()
    await store.saveMessages(account, "1", [message("8", "", [{ kind: "document", name: "Мой_ДОГОВОР Ёлка.docx" }])], {
      via: "history",
    })
    for (const word of ["мой", "договор", "ёлка", "елка"]) expect(ids(await search(store, word))).toEqual(["8"])
  })

  it("**ranks a message that says it above a long spreadsheet that repeats it**", async () => {
    const store = await seeded()
    await store.saveMessages(account, "1", [message("9", "", [{ kind: "document", name: "ledger.xlsx" }])], {
      via: "history",
    })
    const ledger = (await store.fileAttachments(account, { limit: 20 })).find(({ messageId }) => messageId === "9")
    const rows = Array.from({ length: 2_300 }, (_, at) => `Row ${at + 2}: Bird: heron; Count: ${at}`).join("\n")
    expect(rows.length).toBeGreaterThan(75_000)
    await store.keepAttachmentText(ledger?.pk as number, { text: rows, origin: "extracted", extractor: "x" })

    const order = (await search(store, "heron")).items.map(({ id }) => id)
    expect(order[0]).toBe("1")
    expect(order.indexOf("2")).toBeLessThan(order.indexOf("9"))
  })
})
