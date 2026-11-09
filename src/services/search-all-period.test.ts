import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type AccountKey, type MessageStore, openStore } from "../store/store.js"
import { searchAll } from "./search-all.js"

const MAIL: AccountKey = { provider: "email", account: "owner@example.com" }
const NOW = Date.parse("2026-11-09T12:00:00Z")
const live: MessageStore[] = []
afterEach(async () => {
  for (const store of live.splice(0)) await store.close()
})

const seeded = async (mails: { sent: string; body: string }[]) => {
  const store = await openStore({ path: join(mkdtempSync(join(tmpdir(), "search-all-period-")), "store.db") })
  live.push(store)
  const accountId = await store.accounts.saveAccount(MAIL, { name: null })
  for (const [n, { sent, body }] of mails.entries())
    await store.mail.saveThread({
      accountId,
      externalId: `thread-${n}`,
      now: Date.parse(sent),
      emails: [
        {
          externalId: `<${n}@example.com>`,
          subject: `Update ${n}`,
          from: { address: "team@example.com", name: "Team" },
          to: [{ address: "owner@example.com", name: null }],
          sentAt: Date.parse(sent),
          receivedAt: Date.parse(sent),
          bodyText: body,
        },
      ],
    })
  return store
}

const subjects = async (store: MessageStore, text: string, limit = 3, { now = NOW } = {}) =>
  (
    await searchAll(store, MAIL, {
      text,
      limit,
      only: ["mail"],
      now,
      timezone: "UTC",
      env: { WIRECAT_STATE_DIR: mkdtempSync(join(tmpdir(), "no-model-")) },
    })
  ).items.map(({ title }) => title)

// Words rank the two mails that say "deposit" more above the one dated in March.
const DEPOSITS = [
  { sent: "2026-01-12T09:00:00Z", body: "Deposit, deposit: the deposit for the retreat is paid." },
  { sent: "2026-02-09T09:00:00Z", body: "The deposit is paid, deposit receipt attached." },
  { sent: "2026-03-17T09:00:00Z", body: "The deposit is paid." },
]

describe("search all, a question that names a period", () => {
  it("**moves a hit dated inside the period up from below the page**", async () => {
    const store = await seeded(DEPOSITS)
    const [best, second, march] = await subjects(store, "what about the deposit?")
    expect(march).toBe("Update 2")
    expect(await subjects(store, "what about the deposit in March?", 1)).toEqual([march])
    expect(await subjects(store, "what about the deposit in March?")).toEqual([march, best, second])
  })

  it("**reads the period on the request's clock**: last week is the week before `now`", async () => {
    const sent = ["2026-10-20T09:00:00Z", "2026-10-21T09:00:00Z", "2026-11-04T09:00:00Z"]
    const store = await seeded(DEPOSITS.map((mail, n) => ({ ...mail, sent: sent[n] ?? mail.sent })))
    const [best, second, third] = await subjects(store, "what about the deposit?")
    expect(await subjects(store, "what about the deposit last week?")).toEqual([third, best, second])
    const weekLater = { now: NOW + 7 * 86_400_000 }
    expect(await subjects(store, "what about the deposit last week?", 3, weekLater)).toEqual([best, second, third])
  })
})
