import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { syncMail } from "../mail/sync.js"
import { type FakeMail, fakeMailSource } from "../mail/testing/index.js"
import { openCache } from "./open.js"
import { type AccountKey, openStore } from "./store.js"

const ME = "owner@home.example.com"
const NOW = Date.parse("2026-10-04T12:00:00Z")
const SINCE = new Date("2026-09-01T00:00:00Z")

let n = 0
const mail = (from: [string, string], subject: string, day: number, overrides: Partial<FakeMail> = {}): FakeMail => {
  n += 1
  return {
    uid: String(100 + n),
    messageId: `<m${n}@test.example.com>`,
    threadId: String(9000 + n),
    receivedAt: `2026-09-${String(day).padStart(2, "0")}T08:00:00Z`,
    subject,
    from,
    to: [[null, ME]],
    text: `Synthetic body ${n}`,
    ...overrides,
  }
}

const signed = (domain: string, fields: string[]) => [
  `DKIM-Signature: v=1; a=rsa-sha256; d=${domain}; s=s1; h=from:to:subject:${fields.join(":")}; b=abc`,
  `Authentication-Results: mx.google.com; dkim=pass header.i=@${domain} header.s=s1 header.b=abc`,
]

const oneClick = (domain: string, target: string) => [
  `List-Unsubscribe: <${target}>, <mailto:leave@${domain}>`,
  "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
  ...signed(domain, ["list-unsubscribe", "list-unsubscribe-post"]),
]

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const storePath = () => join(mkdtempSync(join(tmpdir(), "mail-subscriptions-")), "store.db")

const synced = async (messages: FakeMail[], path = storePath()) => {
  const store = await openStore({ path })
  handles.push(store)
  await syncMail(fakeMailSource({ messages }), store, { account: { address: ME }, since: SINCE, now: () => NOW })
  return { store, path }
}

const NEWS: [string, string] = ["Weekly News", "news@paper.example.com"]
const SHOP: [string, string] = ["Shop", "deals@store.example.com"]

const inbox = () => [
  mail(NEWS, "Issue 1", 10, { listId: "weekly.paper.example.com" }),
  mail(NEWS, "Issue 2", 17, {
    extraHeaders: [
      "List-Id: Weekly <weekly.paper.example.com>",
      ...oneClick("paper.example.com", "https://paper.example.com/u/2"),
    ],
  }),
  mail(NEWS, "Issue 3", 24, { listId: "weekly.paper.example.com" }),
  mail(SHOP, "Winter sale: 30% off", 12, {
    extraHeaders: [
      "List-Unsubscribe: <https://forged.example.net/u>",
      "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
      ...signed("store.example.com", ["list-unsubscribe-post"]),
    ],
  }),
  mail(SHOP, "Thank you for your order #4411", 13),
  mail(["Pia Lund", "pia@friends.example.com"], "Dinner on Friday?", 20),
]

describe("subscriptions", () => {
  it("groups broadcast mail by List-Id, else by sender, newest first, with the newest mail and the unsubscribe target", async () => {
    const { store } = await synced(inbox())

    const { items, total, hasMore } = await store.mail.subscriptions()

    expect(total).toBe(2)
    expect(hasMore).toBe(false)
    expect(items).toMatchObject([
      {
        key: "list:weekly.paper.example.com",
        listId: "weekly.paper.example.com",
        name: "Weekly News",
        address: "news@paper.example.com",
        emails: 3,
        newest: { subject: "Issue 3", at: Date.parse("2026-09-24T08:00:00Z") },
        unsubscribe: {
          https: "https://paper.example.com/u/2",
          mailto: "mailto:leave@paper.example.com",
          oneClick: true,
        },
      },
      { listId: null, name: "Shop", address: "deals@store.example.com", emails: 1, unsubscribe: null },
    ])
    expect(items[0]?.sender).toMatch(/^(person|sender-bot):\d+$/)
    expect(items[1]?.key).toBe(items[1]?.sender ?? "address:deals@store.example.com")
  })

  it("pages groups in SQL and keeps the total", async () => {
    const { store } = await synced(inbox())

    const second = await store.mail.subscriptions({ limit: 1, offset: 1 })
    expect(second).toMatchObject({ total: 2, hasMore: false, items: [{ name: "Shop" }] })
    expect(await store.mail.subscriptions({ limit: 1 })).toMatchObject({ total: 2, hasMore: true })
    expect(await store.mail.subscriptions({ limit: 1, offset: 5 })).toEqual({ items: [], total: 2, hasMore: false })
    expect((await store.mail.subscriptions({ types: ["promotion"] })).items.map(({ name }) => name)).toEqual(["Shop"])
    const { id } = await store.accounts.storedAccount({ provider: "email", account: ME })
    expect((await store.mail.subscriptions({ accountIds: [id] })).total).toBe(2)
    expect((await store.mail.subscriptions({ accountIds: [] })).total).toBe(0)
  })

  it("answers from a read-only open of a store upgraded before its mail was typed, and writes nothing", async () => {
    const path = storePath()
    const { store } = await synced(inbox(), path)
    await store.close()
    handles.splice(handles.indexOf(store), 1)
    const raw = await openCache(path)
    handles.push(raw)
    // Sync types its mail as it saves it; a store upgraded from before version 76 has none typed.
    raw.exec("UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL")
    const untyped = () => Number(raw.prepare("SELECT count(*) AS n FROM emails WHERE mail_type IS NULL").get()?.n)
    expect(untyped()).toBe(6)
    const readOnly = await openStore({ path, readOnly: true })
    handles.push(readOnly)

    expect((await readOnly.mail.subscriptions()).items.map(({ name, emails }) => ({ name, emails }))).toEqual([
      { name: "Weekly News", emails: 3 },
      { name: "Shop", emails: 1 },
    ])
    expect(untyped()).toBe(6)
  })
})

describe("bots by what they send", () => {
  const TG: AccountKey = { provider: "telegram", account: "1" }

  it("filters bots by the mail types they send and by a messenger account, in SQL", async () => {
    const { store } = await synced([
      mail(["Bank", "noreply@bank.example.com"], "New sign-in to your account", 10),
      mail(["Store", "noreply@store.example.com"], "Thank you for your order #4411", 11),
    ])
    await store.people.savePeople(TG, [{ id: "50", name: "Helper", isBot: true }])
    await store.people.list({ limit: 0 })
    const names = async (sends: Parameters<typeof store.people.listBots>[0]["sends"]) =>
      (await store.people.listBots({ limit: 50, ...(sends ? { sends } : {}) })).items.map(
        ({ displayName }) => displayName,
      )

    expect(await names(undefined)).toEqual(["Bank", "Helper", "Store"])
    expect(await names(["alerts"])).toEqual(["Bank"])
    expect(await names(["receipts"])).toEqual(["Store"])
    expect(await names(["messenger"])).toEqual(["Helper"])
    expect(await names(["alerts", "messenger"])).toEqual(["Bank", "Helper"])
    expect(await names(["marketing"])).toEqual([])
    await expect(store.people.listBots({ limit: 5, sends: ["spam" as "alerts"] })).rejects.toMatchObject({
      details: { reason: "sender-bot.unknown-sends" },
    })
  })
})
