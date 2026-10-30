import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runBudget } from "../background/budget.js"
import { type MessageStore, openStore } from "../store/index.js"
import type { MailRule } from "./rules.js"
import { type MailSyncOptions, syncMail } from "./sync.js"
import { type FakeMail, type FakeMailbox, fakeMailSource } from "./testing/index.js"

const ME = "owner@example.test"
const KEY = { provider: "email", account: ME }
const NOW = Date.parse("2026-10-04T12:00:00Z")
const SINCE = new Date("2026-09-01T00:00:00Z")

const mail = (n: number, overrides: Partial<FakeMail> = {}): FakeMail => ({
  uid: String(100 + n),
  messageId: String(9000 + n),
  threadId: String(9000 + n),
  receivedAt: `2026-09-${String(10 + n).padStart(2, "0")}T08:00:00Z`,
  subject: `Synthetic subject ${n}`,
  from: ["Rin Example", "rin@example.test"],
  to: [[null, ME]],
  text: `Synthetic body ${n}`,
  ...overrides,
})

const opened: MessageStore[] = []
afterEach(async () => {
  for (const each of opened.splice(0)) await each.close()
})

const harness = (messages: FakeMail[], extra: Omit<FakeMailbox, "messages"> = {}) => {
  const env = { ...process.env, MESSAGING_STORE: join(mkdtempSync(join(tmpdir(), "mail-quick-")), "messages.db") }
  const box: FakeMailbox = {
    messages,
    quick: true,
    calls: { search: 0, list: 0, fetchRaw: 0, quick: 0 },
    read: [],
    ...extra,
  }
  const change = (next: Partial<FakeMailbox>) => Object.assign(box, next)
  const sync = async (options: Partial<MailSyncOptions> = {}) => {
    const store = await openStore({ env })
    opened.push(store)
    const result = await syncMail(fakeMailSource(box), store, {
      account: { address: ME, mode: "imap", folders: ["INBOX"] },
      since: SINCE,
      now: () => NOW,
      ...options,
    })
    return { result, store }
  }
  const stored = async () => {
    const store = await openStore({ env })
    opened.push(store)
    return store.mail.emails({ accountId: (await store.accounts.storedAccount(KEY)).id })
  }
  const reset = () => {
    box.calls = { search: 0, list: 0, fetchRaw: 0, quick: 0 }
    box.read = []
  }
  return { box, change, sync, stored, reset }
}

describe("syncMail over a quick listing", () => {
  it("lists without headers, reads each new message once, and stores it under the id its Message-ID gives", async () => {
    const { box, sync, stored } = harness([mail(1), mail(2), mail(3)])

    const { result } = await sync()

    expect(result).toMatchObject({ saved: 3, complete: true, pass: "resumed" })
    expect(box.calls).toMatchObject({ list: 0, quick: 1 })
    expect(box.read?.sort()).toEqual(["101", "102", "103"])
    expect((await stored()).map(({ externalId }) => externalId).sort()).toEqual(["9001", "9002", "9003"])
  })

  it("skips mail stored by an earlier run by its UID, and reads only the new one", async () => {
    const { box, change, sync, reset } = harness([mail(1), mail(2)], { quick: false })
    await sync()
    change({ quick: true, messages: [mail(1), mail(2), mail(3)] })
    reset()

    const { result } = await sync()

    expect(result).toMatchObject({ saved: 1, alreadyStored: 0, complete: true })
    expect(box.read).toEqual(["103"])
    expect(box.calls).toMatchObject({ list: 0, quick: 1, fetchRaw: 1 })
    reset()
    expect((await sync()).result).toMatchObject({ saved: 0, listed: 0 })
    expect(box.read).toEqual([])
  })

  it("lists mail already stored by id, without reading it, when the UIDVALIDITY changed", async () => {
    const { box, change, sync, reset, stored } = harness([mail(1), mail(2)], { quick: false })
    await sync()
    change({ quick: true, validity: 13 })
    reset()

    const { result } = await sync()

    expect(result).toMatchObject({ saved: 0, alreadyStored: 2, pass: "full" })
    expect(box.calls).toMatchObject({ list: 1, quick: 0, fetchRaw: 0 })
    expect(await stored()).toHaveLength(2)
  })

  it("lists in full on --rescan when the store holds the folder's mail, and quickly when it holds none", async () => {
    const { box, change, sync, reset } = harness([mail(1)])
    await sync({ rescan: true })
    expect(box.calls).toMatchObject({ list: 0, quick: 1 })
    change({ messages: [mail(1), mail(2)] })
    reset()

    const { result } = await sync({ rescan: true })

    expect(result).toMatchObject({ alreadyStored: 1, saved: 1, pass: "full" })
    expect(box.calls).toMatchObject({ list: 1, quick: 0 })
    expect(box.read).toEqual(["102"])
  })

  it("merges a message in two folders into one email", async () => {
    const { sync, stored } = harness([mail(1)])

    await sync({ account: { address: ME, mode: "imap", folders: ["INBOX", "[Gmail]/All Mail"] } })

    const emails = await stored()
    expect(emails).toHaveLength(1)
    expect(emails[0]?.mailboxes.map(({ externalId }) => externalId).sort()).toEqual(["INBOX", "[Gmail]/All Mail"])
  })

  it("decides rules on the downloaded headers: a skipped mail is never stored and not read again", async () => {
    const rules: MailRule[] = [
      { match: { domain: "shop.example" }, action: "skip", decided_at: "2026-10-14T00:00:00.000Z" },
    ]
    const { box, sync, stored, reset } = harness([mail(1), mail(2, { from: [null, "sale@shop.example"] })])

    const { result } = await sync({ account: { address: ME, mode: "imap", folders: ["INBOX"], rules } })

    expect(result).toMatchObject({ saved: 1, skipped: 1 })
    expect((await stored()).map(({ externalId }) => externalId)).toEqual(["9001"])
    reset()
    await sync({ account: { address: ME, mode: "imap", folders: ["INBOX"], rules } })
    expect(box.read).toEqual([])
  })

  it("records an envelope mail without its text", async () => {
    const rules: MailRule[] = [
      { match: { domain: "shop.example" }, action: "envelope", decided_at: "2026-10-14T00:00:00.000Z" },
    ]
    const { sync, stored } = harness([mail(1, { from: ["Shop", "sale@shop.example"], text: "secret offer" })])

    const { result } = await sync({ account: { address: ME, mode: "imap", folders: ["INBOX"], rules } })

    expect(result).toMatchObject({ saved: 0, envelopes: 1 })
    const [recorded] = await stored()
    expect(recorded?.bodyText).toBeNull()
    expect(recorded?.subject).toBeNull()
  })

  it("files mail sent to many under the bulk mailbox from its downloaded headers", async () => {
    const { store } = await harness([mail(1, { listId: "news.example" }), mail(2)]).sync()

    const boxes = await store.mail.mailboxes((await store.accounts.storedAccount(KEY)).id)
    expect(boxes.map(({ externalId }) => externalId)).toContain("memo:bulk")
  })

  it("leaves a message the server would not give for the next run", async () => {
    const { box, change, sync, stored, reset } = harness([mail(1), mail(2)], { unreadable: ["102"] })

    const { result } = await sync()

    expect(result).toMatchObject({ saved: 1, complete: false })
    expect(result.unreadable).toHaveLength(1)
    reset()
    change({ unreadable: [] })
    expect((await sync()).result).toMatchObject({ saved: 1, complete: true })
    expect(box.read).toEqual(["102"])
    expect(await stored()).toHaveLength(2)
  })

  it("reads at most max new mails a run, newest first, and goes on with the rest", async () => {
    const { box, sync, reset } = harness([mail(1), mail(2), mail(3)])

    expect((await sync({ max: 2 })).result).toMatchObject({ saved: 2, complete: false })
    expect(box.read).toEqual(["103", "102"])
    reset()
    expect((await sync({ max: 2 })).result).toMatchObject({ saved: 1, complete: true })
    expect(box.read).toEqual(["101"])
  })

  it("lists once and reads in slices under a request budget", async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => mail(i + 1))
    const { box, sync } = harness(twelve, { fetchBatch: 5 })

    const { result } = await sync({ budget: runBudget({}) })

    expect(result).toMatchObject({ saved: 12, complete: true, state: "complete", remaining: 0 })
    expect(box.calls).toEqual({ search: 1, list: 0, quick: 1, fetchRaw: 3 })
    expect(result.requests).toBe(5)
  })

  it("stops a budgeted run when the budget is spent and the next run goes on without reading again", async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => mail(i + 1))
    const { box, sync, reset } = harness(twelve, { fetchBatch: 5 })

    const first = (await sync({ budget: runBudget({ requests: 3 }) })).result
    expect(first).toMatchObject({ saved: 5, complete: false, stopped: "requests" })
    reset()
    const second = (await sync({ budget: runBudget({}) })).result
    expect(second).toMatchObject({ saved: 7, complete: true })
    expect(box.read?.sort()).toEqual(["101", "102", "103", "104", "105", "106", "107"])
  })
})
