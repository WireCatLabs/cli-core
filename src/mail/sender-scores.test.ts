import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { type MessageStore, openStore } from "../store/index.js"
import type { MailRule } from "./rules.js"
import { demotedSenders, SCORE_VERSION, scoreSenders } from "./sender-scores.js"

const opened: MessageStore[] = []
afterEach(async () => {
  for (const store of opened.splice(0)) await store.close()
})

const ME = "owner@example.test"
const DAY = 86_400_000

const ages = (lookUp: (domains: readonly string[]) => Promise<{ looked: number; failed: number }>) => ({
  known: () => new Map(),
  lookUp,
})

const mail = (n: number, from: string, name: string, more: Record<string, unknown> = {}) => ({
  externalId: `<${n}@example.test>`,
  subject: `Synthetic ${n}`,
  from: { address: from, name },
  to: [{ address: ME, name: null }],
  cc: [],
  sentAt: 1_000 + n,
  receivedAt: 1_000 + n,
  references: [],
  bodyText: `Synthetic body ${n}`,
  outgoing: false,
  read: true,
  mailboxes: [],
  ...more,
})

it("scores each sender from the stored mail at most once a day", async () => {
  const env = { ...process.env, MESSAGING_STORE: join(mkdtempSync(join(tmpdir(), "scores-")), "wirecat.db") }
  const store = await openStore({ env })
  opened.push(store)
  const accountId = await store.accounts.saveAccount({ provider: "email", account: ME }, { name: ME })
  await store.mail.saveThread({
    accountId,
    externalId: "t1",
    now: 1,
    emails: [
      mail(1, "alerts@pay-secure.example", "PayPal Support", { headers: { dkim: "fail", dmarc: "fail" } }),
      mail(2, "friend@people.example", "Friend Example"),
    ],
  })
  const now = Date.parse("2026-10-17T00:00:00Z")

  const none = async () => ({ looked: 0, failed: 0 })
  expect(await scoreSenders(store, ME, ages(none), now)).toMatchObject({ scored: 2 })
  expect(await scoreSenders(store, ME, ages(none), now + DAY / 2)).toBeUndefined()

  const state = await store.sync.syncState({ provider: "email", account: ME }, "mail_sender_scores")
  expect(JSON.parse(state?.value ?? "{}")).toEqual({
    version: SCORE_VERSION,
    at: now,
    demoted: ["alerts@pay-secure.example"],
  })
  expect(await scoreSenders(store, ME, ages(none), now + DAY)).toMatchObject({ scored: 2 })
})

it("looks up the domains of senders heard from in the last two years only, never a big mailbox provider", async () => {
  const env = { ...process.env, MESSAGING_STORE: join(mkdtempSync(join(tmpdir(), "scores-")), "wirecat.db") }
  const store = await openStore({ env })
  opened.push(store)
  const accountId = await store.accounts.saveAccount({ provider: "email", account: ME }, { name: ME })
  const now = Date.parse("2026-10-17T00:00:00Z")
  const at = (iso: string) => ({ sentAt: Date.parse(iso), receivedAt: Date.parse(iso) })
  await store.mail.saveThread({
    accountId,
    externalId: "t1",
    now: 1,
    emails: [
      mail(1, "deals@fresh-shop.example", "Fresh Shop", at("2026-09-01T00:00:00Z")),
      mail(2, "news@old-shop.example", "Old Shop", at("2019-01-01T00:00:00Z")),
      mail(3, "friend@gmail.com", "Friend", at("2026-09-02T00:00:00Z")),
    ],
  })
  const asked: string[] = []
  const lookUp = async (domains: readonly string[]) => {
    asked.push(...domains)
    return { looked: domains.length, failed: 0 }
  }

  expect(await scoreSenders(store, ME, ages(lookUp), now)).toMatchObject({ scored: 3, looked: 1 })
  expect(asked).toEqual(["fresh-shop.example"])
})

it("ranks a forged sender lower, unless the owner wrote to its domain or a protect rule keeps it", async () => {
  const env = { ...process.env, MESSAGING_STORE: join(mkdtempSync(join(tmpdir(), "scores-")), "wirecat.db") }
  const store = await openStore({ env })
  opened.push(store)
  const accountId = await store.accounts.saveAccount({ provider: "email", account: ME }, { name: ME })
  const none = async () => ({ looked: 0, failed: 0 })
  const save = (emails: ReturnType<typeof mail>[]) =>
    store.mail.saveThread({ accountId, externalId: "t1", now: 1, emails })
  await save([
    mail(1, "alerts@pay-secure.example", "PayPal Support"),
    mail(2, "help@desk-secure.example", "PayPal Desk"),
  ])
  const keep: MailRule = {
    match: { from: "help@desk-secure.example" },
    action: "keep",
    protected: true,
    decided_at: "2026-10-17",
  }

  expect(await scoreSenders(store, ME, ages(none), 1_000, [keep])).toMatchObject({ demoted: 1 })
  expect(await demotedSenders(store)).toEqual(new Set(["alerts@pay-secure.example"]))

  await save([mail(3, ME, "Owner", { outgoing: true, to: [{ address: "billing@pay-secure.example", name: null }] })])
  expect(await scoreSenders(store, ME, ages(none), 2 * DAY, [keep])).toMatchObject({ demoted: 0 })
})
