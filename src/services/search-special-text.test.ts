import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Message } from "../domain/models.js"
import { type MessageStore, openStore } from "../store/store.js"
import { searchStore } from "./messages-archive-search.js"
import { searchNotes } from "./notes-search.js"
import { searchAll } from "./search-all.js"

const ME = { provider: "synthetic", account: "500" }

// Each query and the record text that holds it; `null` where the query has an operator meaning, so only "no error".
const CASES: [label: string, query: string, record: string | null][] = [
  ["time", "meeting at 10:30", "Steering meeting at 10:30 in room four"],
  ["Cyrillic and a time", "созвон в 14:00", "Завтра созвон в 14:00 с подрядчиком"],
  ["word: that names no field", "Answer as HH:MM", "Answer as HH:MM in the form"],
  ["a:b", "a:b", "the ratio a:b stays"],
  ["URL", "https://example.com/a", "the link https://example.com/a is up"],
  ["unbalanced quote", 'say "unfinished', 'they say "unfinished business'],
  ["unbalanced parenthesis", "(budget draft", "the (budget draft) is late"],
  ["closing parenthesis", "draft)", "see the draft) here"],
  ["slash", "and/or", "pick and/or skip"],
  ["backslash, which escapes the next character", "back\\slash", "the backslash key"],
  ["exclamation mark", "wow!", "that was wow! indeed"],
  ["hash", "#launch", "tagged #launch today"],
  ["at sign", "user@example.com", "write to user@example.com soon"],
  ["ampersand", "R&D", "the R&D budget"],
  ["percent", "50%", "a 50% discount"],
  ["caret", "x^2", "the curve x^2 grows"],
  ["tilde", "~home", "the ~home folder"],
  ["square brackets", "[draft]", "marked [draft] for now"],
  ["curly brackets", "{draft}", "marked {draft} for now"],
  ["pipe", "a|b", "the a|b split"],
  ["angle brackets", "<tag>", "the <tag> element"],
  ["plus inside a word", "C++", "written in C++ mostly"],
  ["apostrophe", "don't O'Brien", "don't tell O'Brien"],
  ["Boolean words in lower case", "black and white", "black and white photos"],
  ["emoji", "party 🎉", "the party 🎉 starts"],
  ["question mark", "ready?", null],
  ["leading minus", "-budget", null],
  ["leading plus", "+budget", null],
  ["asterisk", "budg*", null],
  ["Boolean word alone", "AND", null],
]

let store: MessageStore

beforeAll(async () => {
  store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "special-text-")), "store.db") })
  await store.accounts.saveAccount(ME, { name: "synthetic" })
  await store.chats.saveChats(ME, [
    { id: "7", title: "chat", kind: "group", unreadCount: 0, lastMessageAt: null, participantsCount: 3 },
  ])
  const mailAccountId = await store.accounts.saveAccount({ provider: "email", account: "500" }, { name: "mail" })
  const records = CASES.flatMap(([label, , record]) => (record === null ? [] : [[label, record] as const]))
  await store.messages.saveMessages(
    ME,
    "7",
    records.map(
      ([, text], index): Message => ({
        id: String(index + 1),
        chatId: "7",
        senderId: "700",
        senderName: "Alice Example",
        timestamp: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
        editedAt: null,
        text,
        outgoing: false,
        attachments: [],
        replyTo: null,
        forwardedFrom: null,
        reactions: null,
      }),
    ),
    { via: "history" },
  )
  for (const [index, [, text]] of records.entries()) {
    await store.mail.saveThread({
      accountId: mailAccountId,
      externalId: `thread-${index}`,
      subject: "synthetic",
      emails: [
        {
          externalId: `<m${index}@example.com>`,
          subject: "synthetic",
          from: { address: "alice@example.com", name: "Alice Example" },
          sentAt: Date.UTC(2026, 9, 1),
          bodyText: text,
        },
      ],
      now: Date.UTC(2026, 9, 1),
    })
    await store.notes.addNote({ text })
    await store.deals.add({ by: "owner", kind: "lead", title: text })
  }
  await store.searchIndex.fillSearchIndex({})
  await store.searchIndex.fillStems({})
})
afterAll(async () => {
  await store.close()
})

describe("free text with special characters", () => {
  it.each(CASES)("search all reads %s (%s) with no source refusing it", async (_, query, record) => {
    const found = await searchAll(store, ME, { text: query, limit: 50, only: ["messages", "mail", "notes", "crm"] })
    expect(found.query).toBe(query)
    if (record === null) {
      expect(found.skipped).toEqual(
        found.skipped.length
          ? [expect.objectContaining({ resource: "crm", reason: expect.stringMatching(/title/) })]
          : [],
      )
      return
    }
    expect(found.skipped).toEqual([])
    const holding = found.items.filter(({ text, title }) => `${title ?? ""} ${text}`.includes(record.slice(0, 12)))
    expect(new Set(holding.map(({ kind }) => kind))).toEqual(new Set(["message", "mail", "note", "lead"]))
  })

  it.each(CASES.filter(([, , record]) => record !== null))(
    "search messages and search notes find %s (%s)",
    async (_, query, record) => {
      const messages = await searchStore(store, ME, { text: query, kind: "messages", source: "all", limit: 50 })
      expect(messages.items.map(({ text }) => text)).toContain(record)
      const mail = await searchStore(store, ME, { text: query, kind: "mail", limit: 50 })
      expect(mail.items).not.toEqual([])
      const notes = await searchNotes(store, query, { limit: 50 })
      expect(notes.hits.map(({ excerpt }) => excerpt).join("\n")).toContain((record as string).slice(0, 12))
    },
  )

  it("keeps field queries and Boolean operators", async () => {
    const field = await searchStore(store, ME, { text: "from:alice 10:30", kind: "messages", source: "all", limit: 50 })
    expect(field.items.map(({ text }) => text)).toEqual(["Steering meeting at 10:30 in room four"])
    const none = await searchStore(store, ME, { text: "from:alice -10:30", kind: "messages", source: "all", limit: 50 })
    expect(none.items.map(({ text }) => text)).not.toContain("Steering meeting at 10:30 in room four")
    const or = await searchStore(store, ME, { text: "10:30 OR 14:00", kind: "messages", source: "all", limit: 50 })
    expect(or.items).toHaveLength(2)
    const not = await searchStore(store, ME, { text: "draft NOT late", kind: "messages", source: "all", limit: 50 })
    expect(not.items.map(({ text }) => text)).not.toContain("the (budget draft) is late")
    await expect(
      searchStore(store, ME, { text: "kind:nonsense", kind: "messages", source: "all", limit: 50 }),
    ).rejects.toMatchObject({ code: "validation_error" })
  })
})
