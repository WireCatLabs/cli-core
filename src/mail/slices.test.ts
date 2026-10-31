import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type MessageStore, openStore } from "../store/index.js"
import { syncMail } from "./sync.js"
import { type FakeMail, fakeMailSource } from "./testing/index.js"

const ME = "owner@example.test"
const KEY = { provider: "email", account: ME }
const NOW = Date.parse("2026-10-04T12:00:00Z")
const SINCE = new Date("2026-09-01T00:00:00Z")

const mail = (n: number): FakeMail => ({
  uid: String(100 + n),
  messageId: String(9000 + n),
  threadId: String(9000 + n),
  receivedAt: "2026-09-10T08:00:00Z",
  subject: `Synthetic subject ${n}`,
  from: ["Rin Example", "rin@example.test"],
  to: [[null, ME]],
  text: `Synthetic body ${n}`,
})

const opened: MessageStore[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const each of opened.splice(0)) await each.close()
})

const setup = async (count: number) => {
  const env = { ...process.env, MESSAGING_STORE: join(mkdtempSync(join(tmpdir(), "mail-slices-")), "messages.db") }
  const box = {
    messages: Array.from({ length: count }, (_, index) => mail(index + 1)),
    calls: { search: 0, list: 0, fetchRaw: 0, quick: 0 },
    read: [] as string[],
  }
  const open = async () => {
    const store = await openStore({ env })
    opened.push(store)
    return store
  }
  const sync = (store: MessageStore) =>
    syncMail(fakeMailSource(box), store, {
      account: { address: ME, mode: "imap", folders: ["INBOX"] },
      since: SINCE,
      now: () => NOW,
    })
  const doneCount = async (store: MessageStore) => {
    const value = (await store.sync.syncState(KEY, "mail_resume:INBOX"))?.value
    const done = JSON.parse(value ?? "null")?.done ?? []
    return (done as [number, number][]).reduce((sum, [from, to]) => sum + (to - from + 1), 0)
  }
  return { box, open, sync, doneCount }
}

describe("syncMail saves fetched mail in slices", () => {
  it("commits 50 emails and the resume point together, then the rest", async () => {
    const { open, sync, doneCount } = await setup(120)
    const store = await open()
    const counts: number[] = []
    const real = store.mail.saveThreads.bind(store.mail)
    vi.spyOn(store.mail, "saveThreads").mockImplementation(async (inputs, states) => {
      const saved = await real(inputs, states)
      counts.push(inputs.length, await doneCount(store))
      return saved
    })
    await sync(store)
    expect(counts).toEqual([50, 50, 50, 100, 20, 120])
  })

  it("resumes after the last committed slice when a later slice fails", async () => {
    const { box, open, sync, doneCount } = await setup(120)
    const store = await open()
    const real = store.mail.saveThreads.bind(store.mail)
    let calls = 0
    vi.spyOn(store.mail, "saveThreads").mockImplementation(async (inputs, states) => {
      calls++
      if (calls === 2) throw new Error("database is locked")
      return real(inputs, states)
    })
    await expect(sync(store)).rejects.toThrow("database is locked")
    expect(await store.mail.emails({ accountId: (await store.accounts.storedAccount(KEY)).id })).toHaveLength(50)
    expect(await doneCount(store)).toBe(50)

    vi.restoreAllMocks()
    box.read = []
    await sync(store)
    expect(box.read).toHaveLength(70)
    expect(await doneCount(store)).toBe(120)
  })
})
