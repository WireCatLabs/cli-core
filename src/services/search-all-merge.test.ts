import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
import type { MeaningLane } from "./messages-discovery.js"
import { searchAll } from "./search-all.js"

const MAIL: AccountKey = { provider: "email", account: "owner@example.com" }
const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})

const seeded = async (mails: string[], notes: string[]) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "search-all-merge-")), "store.db") })
  live.push(store)
  const accountId = await store.accounts.saveAccount(MAIL, { name: null })
  for (const [n, bodyText] of mails.entries()) {
    const sent = Date.UTC(2026, 0, 5 + n, 9)
    await store.mail.saveThread({
      accountId,
      externalId: `thread-${n}`,
      now: sent,
      emails: [
        {
          externalId: `<${n}@example.com>`,
          subject: `Update ${n}`,
          from: { address: "team@example.com", name: "Team" },
          to: [{ address: "owner@example.com", name: null }],
          sentAt: sent,
          receivedAt: sent,
          bodyText,
        },
      ],
    })
  }
  for (const text of notes) await store.notes.addNote({ text })
  return store
}

const nearest =
  (mails: number[]): MeaningLane =>
  async () => ({
    model: "e5-small",
    ranked: mails.map((n, rank) => ({
      ...MAIL,
      chatId: `thread-${n}`,
      id: `<${n}@example.com>`,
      score: 0.9 - rank / 100,
    })),
  })

const search = (store: MessageStore, text: string, lane: MeaningLane) =>
  searchAll(
    store,
    MAIL,
    { text, limit: 10, only: ["mail", "notes"], env: { WIRECAT_STATE_DIR: mkdtempSync(join(tmpdir(), "no-model-")) } },
    {},
    undefined,
    lane,
  )

describe("search all's one list of mail and notes", () => {
  it("ranks a note with no vector by its words rank among the mail meaning ranks, each source in its own order", async () => {
    const mails = ["Ana Lee", "Ben Ash", "Cal Moss", "Dee Rook", "Eve Hart", "Tess Ng"].map(
      (name) => `${name}: the team retreat deposit is paid.`,
    )
    const notes = Array.from({ length: 6 }, (_, n) => `Harbour loft, visit ${n + 1}.`)
    const store = await seeded(mails, notes)

    const found = await search(store, "harbour", nearest([0, 1, 2, 3, 4, 5]))

    const kinds = found.items.map(({ kind }) => kind)
    expect(kinds.slice(0, 6).filter((kind) => kind === "mail")).toHaveLength(3)
    const mail = found.items
      .filter(({ kind }) => kind === "mail")
      .map(({ text }) => text.split(":")[0]?.replace(/^Update \d+ /, ""))
    expect(mail).toEqual(["Ana Lee", "Ben Ash", "Cal Moss", "Dee Rook", "Eve Hart"])
  })

  it("keeps a rare word that only words find on the page, above every hit meaning found", async () => {
    const mails = Array.from({ length: 12 }, (_, n) => `Retreat plans, part ${n + 1}.`)
    const store = await seeded([...mails, "The zephyrine contract is signed."], [])

    const found = await search(store, "zephyrine", nearest(mails.map((_, n) => n)))

    expect(found.items[0]).toMatchObject({ kind: "mail", foundBy: ["words"] })
    expect(found.items[0]?.text).toContain("zephyrine")
  })

  it("**keeps a rare word's second hit next to its first**, not behind every hit meaning found", async () => {
    const mails = Array.from({ length: 12 }, (_, n) => `Retreat plans, part ${n + 1}.`)
    const rare = ["The zephyrine contract is signed.", "Zephyrine invoice attached."]
    const store = await seeded([...mails, ...rare], [])

    const found = await search(store, "zephyrine", nearest([12, ...mails.map((_, n) => n)]))

    expect(found.items.slice(0, 2).map(({ foundBy }) => foundBy)).toEqual([["words", "meaning"], ["words"]])
  })

  it("keeps both hits of a rare word that meaning found neither of on the page", async () => {
    const mails = Array.from({ length: 12 }, (_, n) => `Retreat plans, part ${n + 1}.`)
    const rare = ["The zephyrine contract is signed.", "Zephyrine invoice attached."]
    const store = await seeded([...mails, ...rare], [])

    const found = await search(store, "zephyrine", nearest(mails.map((_, n) => n)))

    expect(found.items.slice(0, 10).filter(({ text }) => /zephyrine/i.test(text))).toHaveLength(2)
  })
})
