import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { formatLocator } from "../domain/locator.js"
import type { AttachmentInput, EmailInput } from "../store/index.js"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
import { storeOnlyDeps } from "./deps.js"
import { embeddingsService } from "./embeddings.js"
import { searchStore } from "./messages-archive-search.js"
import { personContext } from "./person-context.js"

const MAIL: AccountKey = { provider: "email", account: "owner@example.com" }
const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})

const at = (day: number) => Date.UTC(2026, 0, day, 9)

const file = (name: string, text: string): AttachmentInput => ({
  position: 0,
  kind: "file",
  mime: "application/pdf",
  name,
  title: null,
  url: null,
  size: 2048,
  width: null,
  height: null,
  duration: null,
  providerRef: { part: 2 },
  localPath: null,
  text,
  normalizedText: null,
  extraction: "text",
  extractor: "pdf:unpdf",
  extractionError: null,
  contentSha256: null,
  extractedAt: at(1),
})

const email = (externalId: string, overrides: Partial<EmailInput>): EmailInput => ({
  externalId,
  subject: "Quarterly planning",
  from: { address: "alice@example.com", name: "Alice Example" },
  to: [{ address: "owner@example.com", name: null }],
  sentAt: at(5),
  receivedAt: at(5),
  bodyText: "Let us agree on the roadmap before Friday.",
  ...overrides,
})

/** Thread-1 and thread-2 in the mail tables; thread-0 only as an older import's messages. */
const seeded = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "mail-search-")), "store.db") })
  live.push(store)
  const accountId = await store.accounts.saveAccount(MAIL, { name: null })
  await store.mail.saveThread({
    accountId,
    externalId: "thread-1",
    now: at(10),
    emails: [
      email("<one@example.com>", {}),
      email("<two@example.com>", {
        subject: "Re: Quarterly planning",
        from: { address: "bob@example.com", name: "Bob Sample" },
        sentAt: at(7),
        receivedAt: at(7),
        bodyText: "Budget attached, see https://example.com/budget",
        attachments: [file("budget.pdf", "Invoice total for the offsite")],
      }),
    ],
  })
  await store.mail.saveThread({
    accountId,
    externalId: "thread-2",
    now: at(10),
    emails: [
      email("<three@example.com>", {
        subject: "Lunch",
        sentAt: at(20),
        receivedAt: at(20),
        bodyText: "The kitchen plans a new menu.",
      }),
    ],
  })
  await store.chats.saveChats(MAIL, [
    {
      id: "thread-0",
      title: "Old notes",
      kind: "dialog",
      unreadCount: null,
      lastMessageAt: null,
      participantsCount: 2,
    },
  ])
  const old = (id: string, text: string) => ({
    id,
    chatId: "thread-0",
    senderId: "alice@example.com",
    senderName: "Alice Example",
    timestamp: new Date(at(2)).toISOString(),
    editedAt: null,
    text,
    outgoing: false,
    attachments: [],
    replyTo: null,
    forwardedFrom: null,
    reactions: null,
  })
  await store.messages.saveMessages(MAIL, "thread-0", [old("<zero@example.com>", "Old notes\n\nThe roadmap draft.")], {
    via: "himalaya",
  })
  return { store, accountId }
}

const search = async (store: MessageStore, text: string, extra: { chat?: string; newest?: boolean } = {}) =>
  searchStore(store, MAIL, { text, kind: "mail", limit: 10, ...extra })
const found = async (store: MessageStore, text: string, extra: { chat?: string; newest?: boolean } = {}) =>
  (await search(store, text, extra)).items.map(({ id }) => id)

describe("search mail over the mail tables", () => {
  it("finds words in the subject and body, and older mail still stored as messages", async () => {
    const { store } = await seeded()
    expect((await found(store, "roadmap")).sort()).toEqual(["<one@example.com>", "<zero@example.com>"])
    const [hit] = (await search(store, "lunch")).items
    expect(hit).toMatchObject({
      id: "<three@example.com>",
      chatId: "thread-2",
      chatTitle: "Lunch",
      senderId: "alice@example.com",
      senderName: "Alice Example",
      text: "Lunch\n\nThe kitchen plans a new menu.",
      locator: formatLocator({ ...MAIL, chat: "thread-2", message: "<three@example.com>" }),
    })
  })

  it("matches stems, prefixes and phrases", async () => {
    const { store } = await seeded()
    expect(await found(store, "planning")).toEqual(expect.arrayContaining(["<three@example.com>", "<one@example.com>"]))
    expect(await found(store, "kitch*")).toEqual(["<three@example.com>"])
    expect(await found(store, '"new menu"')).toEqual(["<three@example.com>"])
  })

  it("filters by sender, thread, date, tag, link and attachment", async () => {
    const { store } = await seeded()
    expect(await found(store, 'from:"bob@example.com"')).toEqual(["<two@example.com>"])
    expect(await found(store, 'from:"Bob Sample"')).toEqual(["<two@example.com>"])
    expect(await found(store, "roadmap OR budget", { chat: "Quarterly planning" })).toEqual([
      "<two@example.com>",
      "<one@example.com>",
    ])
    expect(await found(store, "chat:thread-2")).toEqual(["<three@example.com>"])
    expect(await found(store, "date:[2026-01-15 TO 2026-01-31]")).toEqual(["<three@example.com>"])
    expect(await found(store, "has:link")).toEqual(["<two@example.com>"])
    expect(await found(store, "has:attachment")).toEqual(["<two@example.com>"])
    expect(await found(store, "filename:budget.pdf")).toEqual(["<two@example.com>"])
    expect(await found(store, "content:invoice")).toEqual(["<two@example.com>"])

    await store.tags.addTags(MAIL, { type: "chat", chatId: "thread-2" }, ["food"])
    expect(await found(store, "tag:food")).toEqual(["<three@example.com>"])
  })

  it("filters by recipients, mailbox and subject", async () => {
    const { store, accountId } = await seeded()
    await store.mail.saveThread({
      accountId,
      externalId: "thread-3",
      now: at(12),
      emails: [
        email("<four@example.com>", {
          subject: "Roadmap review",
          bodyText: "Agenda attached.",
          sentAt: at(9),
          receivedAt: at(9),
          to: [{ address: "carol@example.com", name: "Carol Example" }],
          cc: [],
          bcc: [{ address: "bob@example.com", name: "Bob Sample" }],
          mailboxes: [{ externalId: "Label_1", name: "Projects", kind: "label" }],
        }),
      ],
    })
    const sorted = async (text: string) => (await found(store, text)).sort()

    expect(await sorted('to:"carol@example.com"')).toEqual(["<four@example.com>"])
    expect(await sorted("to:carol@example.com")).toEqual(["<four@example.com>"])
    expect(await sorted('to:"Carol Example"')).toEqual(["<four@example.com>"])
    expect(await sorted('bcc:"bob@example.com"')).toEqual(["<four@example.com>"])
    expect(await sorted('to:"owner@example.com" AND from:"bob@example.com"')).toEqual(["<two@example.com>"])
    expect(await sorted("mailbox:Projects")).toEqual(["<four@example.com>"])
    expect(await sorted("mailbox:label_1")).toEqual(["<four@example.com>"])
    const otherId = await store.accounts.saveAccount(
      { provider: "email", account: "other@example.com" },
      { name: null },
    )
    await store.mail.saveThread({
      accountId: otherId,
      externalId: "thread-other",
      now: at(12),
      emails: [
        email("<elsewhere@example.com>", {
          subject: "Lunch",
          bodyText: "Noon at the cafe.",
          mailboxes: [{ externalId: "Label_1", name: "Projects", kind: "label" }],
        }),
      ],
    })
    // One account's search reads every mail account; each email still matches only its own account's mailboxes.
    expect(await sorted("mailbox:Projects")).toEqual(["<elsewhere@example.com>", "<four@example.com>"])
    expect(await sorted("roadmap NOT mailbox:Projects")).toEqual(["<one@example.com>", "<zero@example.com>"])
    expect(await sorted("subject:roadmap")).toEqual(["<four@example.com>"])
    expect(await sorted("roadmap")).toEqual(["<four@example.com>", "<one@example.com>", "<zero@example.com>"])
    expect(await sorted('subject:"quarterly planning"')).toEqual(["<one@example.com>", "<two@example.com>"])

    const TG: AccountKey = { provider: "tg", account: "1" }
    await expect(searchStore(store, TG, { text: "subject:roadmap", limit: 5 })).rejects.toThrow(
      "subject: is a mail field",
    )
  })

  it("filters by read and starred state, and label: as mailbox:", async () => {
    const { store, accountId } = await seeded()
    await store.mail.saveThread({
      accountId,
      externalId: "thread-3",
      now: at(12),
      emails: [
        email("<four@example.com>", {
          read: false,
          flagged: true,
          mailboxes: [{ externalId: "Label_1", name: "Projects", kind: "label" }],
        }),
        email("<five@example.com>", {
          read: true,
          flagged: false,
          mailboxes: [{ externalId: "Label_2", name: "Счета", kind: "label" }],
        }),
      ],
    })
    const sorted = async (text: string) => (await found(store, text)).sort()

    expect(await sorted("is:unread")).toEqual(["<four@example.com>"])
    expect(await sorted("is:read")).toEqual(["<five@example.com>"])
    expect(await sorted("is:starred")).toEqual(["<four@example.com>"])
    expect(await sorted("roadmap -is:unread")).toEqual([
      "<five@example.com>",
      "<one@example.com>",
      "<zero@example.com>",
    ])
    expect(await sorted("label:projects")).toEqual(["<four@example.com>"])
    expect(await sorted("label:Label_1")).toEqual(["<four@example.com>"])
    expect(await sorted("label:СЧЕТА")).toEqual(["<five@example.com>"])
    await expect(search(store, "is:important")).rejects.toThrow("is takes unread, read, starred")

    const TG: AccountKey = { provider: "tg", account: "1" }
    await expect(searchStore(store, TG, { text: "is:unread", limit: 5 })).rejects.toThrow("is: is a mail field")
  })

  it("finds a letter by its whole tracking link and by a quoted part of a link", async () => {
    const { store, accountId } = await seeded()
    await store.mail.saveThread({
      accountId,
      externalId: "thread-3",
      now: at(10),
      emails: [email("<news@example.com>", { bodyText: "Read https://news.example.com/click?id=1&utm_source=mail" })],
    })
    await store.mentions.rebuildMentions({ kinds: ["url"] })

    expect(await found(store, 'url:"https://news.example.com/click?id=1"')).toEqual(["<news@example.com>"])
    expect(await found(store, 'link:"/click?id=1"')).toEqual(["<news@example.com>"])
    expect(await found(store, 'link:"budget"')).toEqual(["<two@example.com>"])
    expect(await found(store, "domain:example.com")).toHaveLength(2)
    await expect(found(store, "link:click?id=1")).rejects.toThrow(/invalid-syntax/)
  })

  it("refuses messenger-only fields", async () => {
    const { store } = await seeded()
    await expect(search(store, "kind:group")).rejects.toThrow("mail has no kind")
  })

  it("lists an email imported again once, from the mail tables", async () => {
    const { store, accountId } = await seeded()
    await store.mail.saveThread({
      accountId,
      externalId: "thread-0",
      now: at(11),
      emails: [email("<zero@example.com>", { subject: "Old notes", bodyText: "The roadmap draft.", sentAt: at(2) })],
    })
    const hits = (await search(store, "roadmap", { newest: true })).items
    expect(hits.map(({ id }) => id)).toEqual(["<one@example.com>", "<zero@example.com>"])
    expect(hits[1]?.chatTitle).toBe("Old notes")
  })

  it("purges a mail account with its mail, attachments, pieces and thread tags", async () => {
    const { store } = await seeded()
    await store.tags.addTags(MAIL, { type: "chat", chatId: "thread-2" }, ["food"])
    await store.mail.chunksToEmbed("test:model:2", { limit: 10 })
    await store.accounts.purge(MAIL)
    expect(await store.mail.threads({ includeDeleted: true })).toEqual([])
    expect(await store.mail.emails({ includeDeleted: true })).toEqual([])
    expect(await store.mail.chunksToEmbed("test:model:2", { limit: 10 })).toEqual([])
    expect(await store.accounts.accounts()).not.toContainEqual(MAIL)
  })

  it("leaves a deleted email out", async () => {
    const { store, accountId } = await seeded()
    await store.mail.markDeleted(accountId, ["<three@example.com>"], at(30))
    expect(await found(store, "lunch")).toEqual([])
  })

  it("finds mail in a search that names a messenger account too, and skips mail for a messenger field", async () => {
    const { store, accountId } = await seeded()
    const TG: AccountKey = { provider: "tg", account: "1" }
    await store.chats.saveChats(TG, [
      { id: "5", title: "Team", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: null },
    ])
    await store.messages.saveMessages(
      TG,
      "5",
      [
        {
          id: "1",
          chatId: "5",
          senderId: "9",
          senderName: "Carol Example",
          timestamp: new Date(at(3)).toISOString(),
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
    const both = async (text: string) =>
      (await searchStore(store, TG, { text, accounts: [TG, MAIL], limit: 10 })).items.map(({ locator }) => locator)
    expect(await both("roadmap")).toEqual(
      expect.arrayContaining([
        formatLocator({ ...TG, chat: "5", message: "1" }),
        formatLocator({ ...MAIL, chat: "thread-1", message: "<one@example.com>" }),
      ]),
    )
    expect(await both("roadmap kind:group")).toEqual([formatLocator({ ...TG, chat: "5", message: "1" })])
    await store.mail.setFlags(accountId, new Map([["<one@example.com>", { read: true }]]), at(11))
    expect(await both("roadmap is:read")).toEqual([
      formatLocator({ ...MAIL, chat: "thread-1", message: "<one@example.com>" }),
    ])
  })

  it("puts their mail in a person's context", async () => {
    const { store } = await seeded()
    const context = await personContext(store, MAIL, "bob@example.com")
    expect(context.recent.direct.map(({ id }) => id)).toEqual(["<two@example.com>"])
    expect(context.last.fromThem).toMatchObject({
      id: "<two@example.com>",
      chatTitle: "Quarterly planning",
      locator: formatLocator({ ...MAIL, chat: "thread-1", message: "<two@example.com>" }),
    })
    expect(context.recent.groups).toEqual([])
  })
})

describe("mail by meaning", () => {
  const MODEL = "test:model:2"
  const unit = (x: number, y: number) => new Float32Array([x, y])

  it("hands out each email and attachment piece once and answers nearest conversations with email threads", async () => {
    const { store, accountId } = await seeded()
    const chunks = await store.mail.chunksToEmbed(MODEL, { limit: 10 })
    expect(chunks.length).toBe(4)
    await store.vectors.saveVectors(
      MODEL,
      2,
      chunks.map(({ hash, text }) => ({
        hash,
        vector: text.includes("Lunch")
          ? unit(0, 1)
          : text.includes("Invoice")
            ? unit(-1, 0)
            : text.includes("Budget")
              ? unit(0.6, 0.8)
              : unit(1, 0),
      })),
    )
    expect(await store.mail.chunksToEmbed(MODEL, { limit: 10 })).toEqual([])

    const [best] = await store.vectors.nearestConversations(MAIL, { model: MODEL, query: unit(0, 1), limit: 2 })
    expect(best).toMatchObject({
      summary: { chatId: "thread-2", firstMessageId: "<three@example.com>", messageCount: 1 },
      chunk: { firstMessageId: "<three@example.com>", lastMessageId: "<three@example.com>" },
      score: 1,
    })
    const [byFile] = await store.vectors.nearestConversations(MAIL, { model: MODEL, query: unit(-1, 0), limit: 1 })
    expect(byFile).toMatchObject({ chunk: { firstMessageId: "<two@example.com>" }, score: 1 })

    const inThread = await store.vectors.nearestConversations(MAIL, {
      model: MODEL,
      query: unit(0, 1),
      limit: 5,
      chatId: "thread-1",
    })
    expect(inThread.map(({ chunk }) => chunk.firstMessageId)).toEqual(["<two@example.com>", "<one@example.com>"])

    await store.mail.markDeleted(accountId, ["<three@example.com>"], at(30))
    const after = await store.vectors.nearestConversations(MAIL, { model: MODEL, query: unit(0, 1), limit: 5 })
    expect(after.map(({ chunk }) => chunk.firstMessageId)).not.toContain("<three@example.com>")
  })

  it("embeds only the reply's own piece when it arrives, without the quote it repeats", async () => {
    const { store, accountId } = await seeded()
    const long = (n: number) => `Point ${n}: ${"the venue needs a bigger room for the team ".repeat(6)}`
    const first = Array.from({ length: 8 }, (_, n) => long(n)).join("\n\n")
    const reply = (id: string, day: number, text: string) =>
      email(id, { subject: "Re: Offsite", sentAt: at(day), receivedAt: at(day), bodyText: text })
    await store.mail.saveThread({
      accountId,
      externalId: "thread-3",
      now: at(11),
      emails: [
        email("<four@example.com>", { subject: "Offsite", sentAt: at(11), receivedAt: at(11), bodyText: first }),
      ],
    })
    const before = await store.mail.chunksToEmbed(MODEL, { limit: 20 })
    expect(before.length).toBeGreaterThan(4)
    await store.vectors.saveVectors(
      MODEL,
      2,
      before.map(({ hash }) => ({ hash, vector: unit(1, 0) })),
    )

    const quoted = first
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")
    await store.mail.saveThread({
      accountId,
      externalId: "thread-3",
      now: at(12),
      emails: [reply("<five@example.com>", 12, `Booked Hall B.\n\nOn Sunday, Alice Example wrote:\n${quoted}`)],
    })
    const added = await store.mail.chunksToEmbed(MODEL, { limit: 20 })
    expect(added).toHaveLength(1)
    expect(added[0]?.text).toContain("Booked Hall B.")
    expect(added[0]?.text).not.toContain("> Point")
  })

  it("finds an email by words in search conversations, as its thread", async () => {
    const { store } = await seeded()
    const cache = mkdtempSync(join(tmpdir(), "no-models-"))
    const env = { WIRECAT_STATE_DIR: cache, XDG_CACHE_HOME: cache }
    const embeddings = embeddingsService(storeOnlyDeps(store, MAIL, { app: { command: "memo" } as never, env }))
    const { hits, meaning } = await embeddings.search("kitchen", { limit: 5 })
    expect(meaning).toBe("unavailable")
    expect(hits.map(({ summary, chunk, locator }) => [summary.chatId, chunk.firstMessageId, locator])).toEqual([
      ["thread-2", "<three@example.com>", formatLocator({ ...MAIL, chat: "thread-2", message: "<three@example.com>" })],
    ])
  })
})
