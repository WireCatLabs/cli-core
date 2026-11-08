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
  it("**gives the page to the hits meaning scored**: mail at its rank 3 to 6 goes ahead of notes it did not", async () => {
    const mails = ["Ana Lee", "Ben Ash", "Cal Moss", "Dee Rook", "Eve Hart", "Tess Ng"].map(
      (name) => `${name}: the team retreat deposit is paid.`,
    )
    const notes = Array.from({ length: 6 }, (_, n) => `Harbour loft, visit ${n + 1}.`)
    const store = await seeded(mails, notes)

    const found = await search(store, "harbour", nearest([0, 1, 2, 3, 4, 5]))

    const kinds = found.items.map(({ kind }) => kind)
    expect(kinds.filter((kind) => kind === "mail")).toHaveLength(6)
    expect(kinds.slice(0, 2).sort()).toEqual(["mail", "note"])
    expect(kinds.slice(2, 7)).toEqual(Array(5).fill("mail"))
  })

  it("keeps a rare word that only words find on the page, above every hit meaning found", async () => {
    const mails = Array.from({ length: 12 }, (_, n) => `Retreat plans, part ${n + 1}.`)
    const store = await seeded([...mails, "The zephyrine contract is signed."], [])

    const found = await search(store, "zephyrine", nearest(mails.map((_, n) => n)))

    expect(found.items[0]).toMatchObject({ kind: "mail", foundBy: ["words"] })
    expect(found.items[0]?.text).toContain("zephyrine")
  })
})
