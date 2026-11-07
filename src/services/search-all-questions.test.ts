import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
import type { MeaningLane } from "./messages-discovery.js"
import { searchAll } from "./search-all.js"

const MAIL: AccountKey = { provider: "email", account: "owner@example.com" }
const QUESTION = "What is the current confirmed delivery date for Amber Kite?"
const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})

const seeded = async () => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "search-all-questions-")), "store.db") })
  live.push(store)
  const accountId = await store.accounts.saveAccount(MAIL, { name: null })
  const sent = Date.UTC(2026, 0, 5, 9)
  await store.mail.saveThread({
    accountId,
    externalId: "thread-1",
    now: sent,
    emails: [
      {
        externalId: "<one@example.com>",
        subject: "Amber Kite",
        from: { address: "alice@example.com", name: "Alice Example" },
        to: [{ address: "owner@example.com", name: null }],
        sentAt: sent,
        receivedAt: sent,
        bodyText: "Amber Kite delivery moved: confirmed for 14 May.",
      },
    ],
  })
  await store.notes.addNote({ text: "Amber Kite: the delivery date is confirmed, 14 May." })
  await store.notes.addNote({ text: "Birch Compass budget approved." })
  return store
}

const kinds = async (store: MessageStore, text: string, exact = false) =>
  (await searchAll(store, MAIL, { text, limit: 10, only: ["mail", "notes"], ...(exact ? { exact: true } : {}) })).items
    .map(({ kind }) => kind)
    .sort()

describe("search all with a question typed as a sentence", () => {
  it("finds the mail and the note that hold some of its words", async () => {
    const store = await seeded()

    expect(await kinds(store, QUESTION)).toEqual(["mail", "note"])
  })

  it("keeps --exact strict: every word as written", async () => {
    const store = await seeded()

    expect(await kinds(store, QUESTION, true)).toEqual([])
  })

  it("keeps plain words strict when they are not a question", async () => {
    const store = await seeded()

    expect(await kinds(store, "amber kite budget")).toEqual([])
    expect(await kinds(store, "amber kite delivery")).toEqual(["mail", "note"])
  })
})

describe("search all with a question the answer words differently", () => {
  const offsite = ["Ana Lee", "Ben Ash", "Cal Moss", "Dee Rook", "Eve Hart"].map(
    (name, n) => `Grove Atlas offsite. ${name}: the Grove Atlas offsite advance is planned for May ${n + 1}.`,
  )
  const answer = "Grove Atlas team retreat deposit. Tess Ng: paid it this morning."

  const mailbox = async () => {
    const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "search-all-reworded-")), "store.db") })
    live.push(store)
    const accountId = await store.accounts.saveAccount(MAIL, { name: null })
    for (const [n, bodyText] of [...offsite, answer].entries()) {
      const sent = Date.UTC(2026, 0, 5 + n, 9)
      await store.mail.saveThread({
        accountId,
        externalId: `thread-${n}`,
        now: sent,
        emails: [
          {
            externalId: `<${n}@example.com>`,
            subject: bodyText.split(".")[0] ?? "",
            from: { address: "team@example.com", name: "Team" },
            to: [{ address: "owner@example.com", name: null }],
            sentAt: sent,
            receivedAt: sent,
            bodyText,
          },
        ],
      })
    }
    return store
  }

  it("brings into the first two the mail meaning ranks first, though words rank it last", async () => {
    const store = await mailbox()
    const near = [5, 0, 1, 2, 3, 4].map((n, rank) => ({
      ...MAIL,
      chatId: `thread-${n}`,
      id: `<${n}@example.com>`,
      score: 0.9 - rank / 100,
    }))
    const lane: MeaningLane = async () => ({ model: "e5-small", ranked: near })
    const question = "Who put down the money for the Grove Atlas offsite advance?"

    const found = await searchAll(store, MAIL, { text: question, limit: 10, only: ["mail"] }, {}, undefined, lane)

    const texts = found.items.map(({ text }) => text)
    expect(texts).toHaveLength(6)
    expect(texts.slice(0, 2).some((text) => text.includes("Tess Ng"))).toBe(true)
  })
})
