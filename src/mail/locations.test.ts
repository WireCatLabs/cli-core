import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runBudget } from "../background/budget.js"
import { type MessageStore, openStore } from "../store/index.js"
import { type MailSyncOptions, syncMail } from "./sync.js"
import { type FakeMail, type FakeMailbox, fakeMailSource } from "./testing/index.js"

const ME = "owner@example.test"
const KEY = { provider: "email", account: ME }
const NOW = Date.parse("2026-10-04T12:00:00Z")
const SINCE = new Date("2026-09-01T00:00:00Z")
const ALL = "[Gmail]/All Mail"
const BIN = "[Gmail]/Bin"

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
  const env = { ...process.env, MESSAGING_STORE: join(mkdtempSync(join(tmpdir(), "mail-locations-")), "messages.db") }
  const box: FakeMailbox = {
    messages,
    quick: true,
    calls: { search: 0, list: 0, fetchRaw: 0, quick: 0 },
    read: [],
    ...extra,
  }
  const open = async () => {
    const store = await openStore({ env })
    opened.push(store)
    return store
  }
  const sync = async (options: Partial<MailSyncOptions> = {}, folders = ["INBOX"]) => {
    const store = await open()
    return syncMail(fakeMailSource(box), store, {
      account: { address: ME, mode: "imap", folders },
      since: SINCE,
      now: () => NOW,
      ...options,
    })
  }
  const reset = () => {
    box.calls = { search: 0, list: 0, fetchRaw: 0, quick: 0 }
    box.read = []
  }
  const inStore = async () => {
    const store = await open()
    const accountId = (await store.accounts.storedAccount(KEY)).id
    return {
      live: async () => (await store.mail.emails({ accountId })).map(({ externalId }) => externalId).sort(),
      email: (id: string) => store.mail.email(accountId, id),
      uids: async (folder: string, validity = "12") =>
        (await store.mail.folderEmails(accountId, folder, validity)).map(({ uid }) => uid),
      point: async (folder: string) =>
        JSON.parse((await store.sync.syncState(KEY, `mail_resume:${folder}`))?.value ?? "null"),
    }
  }
  return { box, sync, reset, inStore }
}

describe("a quick sync keeps where each email is, and so refreshes flags and proves deletions", () => {
  it("stores the UID of every email it saves, and refreshes its flags without reading it again", async () => {
    const { box, sync, reset, inStore } = harness([mail(1), mail(2)])
    await sync()
    expect(await (await inStore()).uids("INBOX")).toEqual([101, 102])
    reset()
    box.messages = [mail(1, { seen: true, flagged: true }), mail(2)]

    await sync()

    expect(box.read).toEqual([])
    expect(box.calls).toMatchObject({ list: 0, quick: 1, fetchRaw: 0 })
    const store = await inStore()
    expect(await store.email("9001")).toMatchObject({ read: true, flagged: true })
    expect(await store.email("9002")).toMatchObject({ read: false, flagged: false })
  })

  it("proves a deletion from the UIDs the server no longer lists", async () => {
    const { box, sync, inStore } = harness([mail(1), mail(2), mail(3)])
    await sync()
    box.messages = [mail(1), mail(3)]

    const result = await sync()

    expect(result).toMatchObject({ deleted: 1, saved: 0, complete: true })
    const store = await inStore()
    expect(await store.live()).toEqual(["9001", "9003"])
    expect(await store.uids("INBOX")).toEqual([101, 103])
    expect(await store.email("9002")).toMatchObject({ bodyText: null })
  })

  it("leaves mail older than the window's trusted days alone", async () => {
    const { box, sync, inStore } = harness([mail(1, { receivedAt: "2026-09-01T08:00:00Z" }), mail(2)])
    await sync()
    box.messages = [mail(2)]

    expect(await sync()).toMatchObject({ deleted: 0 })
    expect(await (await inStore()).live()).toEqual(["9001", "9002"])
  })

  it("refuses to delete a large share, as a header listing does", async () => {
    const { box, sync, inStore } = harness(Array.from({ length: 8 }, (_, i) => mail(i + 1)))
    await sync()
    box.messages = [mail(8)]

    const result = await sync()

    expect(result).toMatchObject({ deleted: 0 })
    expect(result.deletionsSkipped).toMatch(/too many/)
    expect(await (await inStore()).live()).toHaveLength(8)
  })

  it("keeps an email in two folders until it is gone from both", async () => {
    const { box, sync, inStore } = harness([mail(1), mail(2)])
    const folders = ["INBOX", ALL]
    await sync({}, folders)
    expect(await (await inStore()).uids(ALL)).toEqual([101, 102])

    box.messages = [mail(1, { absentFrom: [ALL] }), mail(2)]
    expect(await sync({}, folders)).toMatchObject({ deleted: 0 })
    let store = await inStore()
    expect(await store.live()).toEqual(["9001", "9002"])
    expect(await store.uids(ALL)).toEqual([102])
    expect((await store.email("9001"))?.mailboxes.map(({ externalId }) => externalId)).toEqual(["INBOX"])

    box.messages = [mail(2)]
    expect(await sync({}, folders)).toMatchObject({ deleted: 1 })
    store = await inStore()
    expect(await store.live()).toEqual(["9002"])
    expect(await store.uids("INBOX")).toEqual([102])
  })

  it("follows an email moved to another folder: located there, not deleted", async () => {
    const { box, sync, reset, inStore } = harness([mail(1), mail(2)])
    const folders = ["INBOX", BIN]
    await sync({}, folders)
    reset()
    box.messages = [mail(1, { folder: "trash" }), mail(2)]

    const result = await sync({}, folders)

    expect(result).toMatchObject({ deleted: 0, alreadyStored: 1 })
    const store = await inStore()
    expect(await store.live()).toEqual(["9001", "9002"])
    expect(await store.uids(BIN)).toEqual([101])
    expect(await store.uids("INBOX")).toEqual([102])
    expect((await store.email("9001"))?.mailboxes.map(({ externalId }) => externalId)).toEqual([BIN])
  })

  it("drops a folder's locations when its UIDVALIDITY changes, and lists in full once", async () => {
    const { box, sync, reset, inStore } = harness([mail(1), mail(2)])
    await sync()
    box.validity = 13
    reset()

    const result = await sync()

    expect(result).toMatchObject({ saved: 0, alreadyStored: 2, pass: "full" })
    expect(box.calls).toMatchObject({ list: 1, quick: 0, fetchRaw: 0 })
    const store = await inStore()
    expect(await store.uids("INBOX", "12")).toEqual([])
    expect(await store.uids("INBOX", "13")).toEqual([101, 102])
    reset()
    box.messages = [mail(1)]
    expect(await sync()).toMatchObject({ deleted: 1 })
    expect(box.calls).toMatchObject({ list: 0, quick: 1 })
  })

  it("proves nothing in a budgeted run that stopped before reading the window", async () => {
    const { box, sync, inStore } = harness([mail(1), mail(2)], { fetchBatch: 5 })
    await sync()
    box.messages = [mail(2), ...Array.from({ length: 12 }, (_, i) => mail(i + 3))]

    const partial = await sync({ budget: runBudget({ requests: 2 }) })

    expect(partial).toMatchObject({ complete: false, deleted: 0, stopped: "requests" })
    expect(await (await inStore()).live()).toContain("9001")
    box.fetchBatch = 20
    const whole = await sync({ budget: runBudget({}) })
    expect(whole).toMatchObject({ deleted: 1, complete: true })
    expect(await (await inStore()).live()).not.toContain("9001")
  })

  it("does not take a UID the listing failed to return for a UID the server dropped", async () => {
    const { box, sync, inStore } = harness([mail(1), mail(2)])
    await sync()
    box.failOnce = ["101"]

    const result = await sync({ budget: runBudget({}) })

    expect(result).toMatchObject({ deleted: 0 })
    expect(await (await inStore()).live()).toEqual(["9001", "9002"])
  })
})

describe("mail stored before locations existed", () => {
  it("gets them from one header listing, reading nothing, and is quick afterwards", async () => {
    const { box, sync, reset, inStore } = harness([mail(1), mail(2)], { quick: false })
    await sync()
    expect(await (await inStore()).uids("INBOX")).toEqual([])
    box.quick = true
    box.messages = [mail(1, { seen: true }), mail(2), mail(3)]
    reset()

    const backfill = await sync()

    expect(backfill).toMatchObject({ saved: 1, alreadyStored: 2, pass: "full" })
    expect(box.calls).toMatchObject({ list: 1, quick: 0 })
    expect(box.read).toEqual(["103"])
    let store = await inStore()
    expect(await store.uids("INBOX")).toEqual([101, 102, 103])
    expect((await store.point("INBOX")).located).toBe(SINCE.toISOString())
    reset()
    box.messages = [mail(1, { seen: true }), mail(3)]

    const quick = await sync()

    expect(quick).toMatchObject({ deleted: 1, saved: 0 })
    expect(box.calls).toMatchObject({ list: 0, quick: 1, fetchRaw: 0 })
    store = await inStore()
    expect(await store.live()).toEqual(["9001", "9003"])
  })

  it("is listed in full again when the window is wider than the one located", async () => {
    const { box, sync, reset } = harness([mail(1), mail(2)])
    await sync({ since: new Date("2026-09-05T00:00:00Z") })
    reset()

    await sync({ since: new Date("2026-09-01T00:00:00Z") })

    expect(box.calls).toMatchObject({ list: 1, quick: 0 })
  })
})
