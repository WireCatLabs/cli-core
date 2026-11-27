import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { syncMail } from "../mail/sync.js"
import { type FakeMail, fakeMailSource } from "../mail/testing/index.js"
import { openCache } from "./open.js"
import { type MessageStore, openStore } from "./store.js"

const ME = "owner@home.example.com"
const NOW = Date.parse("2026-10-04T12:00:00Z")
const SINCE = new Date("2026-09-01T00:00:00Z")

let n = 0
const mail = (from: [string, string], subject: string, overrides: Partial<FakeMail> = {}): FakeMail => {
  n += 1
  return {
    uid: String(100 + n),
    messageId: `<m${n}@test.example.com>`,
    threadId: String(9000 + n),
    receivedAt: `2026-09-${String(10 + (n % 15)).padStart(2, "0")}T08:00:00Z`,
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

const marketing = (domain: string) => [
  "List-Unsubscribe: <https://unsubscribe.example.com/x>",
  "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
  ...signed(domain, ["list-unsubscribe-post"]),
]

const handles: { close(): unknown }[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const storePath = () => join(mkdtempSync(join(tmpdir(), "mail-types-")), "store.db")

const synced = async (messages: FakeMail[], path = storePath()) => {
  const store = await openStore({ path })
  handles.push(store)
  await syncMail(fakeMailSource({ messages }), store, { account: { address: ME }, since: SINCE, now: () => NOW })
  return { store, path }
}

const typed = async (store: MessageStore) =>
  Object.fromEntries(
    (await store.mail.emails({ limit: 500 })).map((email) => [
      email.subject,
      { type: email.mailType, reach: email.reach, signal: email.typeSignal },
    ]),
  )

describe("the type of each email", () => {
  it("types each email from what the store keeps of it, first match wins", async () => {
    const team = Array.from({ length: 12 }, (_, i): [null, string] => [null, `colleague${i}@work.example.com`])
    const list = "<dev.lists.example.org>"
    const { store } = await synced([
      mail(["Mail Delivery Subsystem", "mailer-daemon@relay.example.com"], "Undelivered Mail Returned to Sender", {
        attachment: { name: "details.txt", mime: "message/delivery-status", content: "Status: 5.1.1" },
      }),
      mail(["Ola Brandt", "ola@partner.example.com"], "Out of office: back on Monday"),
      mail(["Bank Security", "security@bank.example.com"], "New sign-in to your account"),
      mail(["Ola Brandt", "ola@partner.example.com"], "Planning", {
        attachment: { name: "invite.ics", mime: "text/calendar", content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR" },
      }),
      mail(["Shop", "shop@store.example.com"], "Thank you for your order #4411"),
      mail(["Shop", "shop@store.example.com"], "Black Friday: 40% off everything", {
        extraHeaders: marketing("store.example.com"),
      }),
      mail(["Parcels", "tracking@parcels.example.com"], "Your parcel is on its way"),
      mail(["Phone Co", "billing@phone.example.com"], "Your bill is ready"),
      mail(["Weekly Author", "author@letters.example.com"], "Notes from the road", {
        extraHeaders: ["List-Unsubscribe: <mailto:leave@letters.example.com>"],
        listId: "<author.letters.example.com>",
      }),
      mail(["Ada", "ada@dev.example.org"], "[dev] release plan", { listId: list }),
      mail(["Bo", "bo@dev.example.org"], "[dev] re: release plan", { listId: list }),
      mail(["Cy", "cy@dev.example.org"], "[dev] re: re: release plan", { listId: list }),
      mail(["Monitor", "alerts@ops.example.com"], "[FIRING:1] disk full"),
      mail(["Service", "noreply@service.example.com"], "Terms of service update"),
      mail(["Ola Brandt", "ola@partner.example.com"], "All hands", { to: [[null, ME], ...team] }),
      mail(["Pia Lund", "pia@friends.example.com"], "Dinner on Friday?"),
    ])

    expect(await typed(store)).toEqual({
      "Undelivered Mail Returned to Sender": {
        type: "auto_reply",
        reach: "direct",
        signal: "message/delivery-status",
      },
      "Out of office: back on Monday": { type: "auto_reply", reach: "direct", signal: "auto-reply-subject" },
      "New sign-in to your account": { type: "security", reach: "direct", signal: "security-address" },
      Planning: { type: "calendar", reach: "direct", signal: "text/calendar" },
      "Thank you for your order #4411": { type: "order", reach: "direct", signal: "order-subject" },
      "Black Friday: 40% off everything": { type: "promotion", reach: "broadcast", signal: "promotion-subject" },
      "Your parcel is on its way": { type: "shipping", reach: "direct", signal: "shipping-address" },
      "Your bill is ready": { type: "bill", reach: "direct", signal: "bill-address" },
      "Notes from the road": { type: "newsletter", reach: "broadcast", signal: "list-id" },
      "[dev] release plan": { type: "discussion_list", reach: "group", signal: "discussion-list" },
      "[dev] re: release plan": { type: "discussion_list", reach: "group", signal: "discussion-list" },
      "[dev] re: re: release plan": { type: "discussion_list", reach: "group", signal: "discussion-list" },
      "[FIRING:1] disk full": { type: "system_alert", reach: "direct", signal: "alert-address" },
      "Terms of service update": { type: "account_notice", reach: "direct", signal: "no-reply" },
      "All hands": { type: "personal", reach: "group", signal: "person" },
      "Dinner on Friday?": { type: "personal", reach: "direct", signal: "person" },
    })
    const subjects = async (filter: Parameters<MessageStore["mail"]["emails"]>[0]) =>
      (await store.mail.emails(filter)).map(({ subject }) => subject).sort()
    expect(await subjects({ types: ["order", "promotion"] })).toEqual([
      "Black Friday: 40% off everything",
      "Thank you for your order #4411",
    ])
    expect(await subjects({ reaches: ["group"], types: ["personal"] })).toEqual(["All hands"])
  })

  it("never types mail from someone the owner writes to by an address word or a subject alone", async () => {
    const { store } = await synced([
      mail(["Info Desk", "info@smallfirm.example.com"], "Your order of the agenda"),
      mail(["Me", ME], "Re: agenda", { to: [[null, "info@smallfirm.example.com"]], sent: true }),
      mail(["Info Desk", "info@smallfirm.example.com"], "Our sale ends Friday", {
        extraHeaders: marketing("smallfirm.example.com"),
      }),
    ])

    expect(await typed(store)).toMatchObject({
      "Your order of the agenda": { type: "personal", signal: "owner-wrote" },
      "Re: agenda": { type: "personal", signal: "owner-wrote" },
      "Our sale ends Friday": { type: "promotion", reach: "broadcast" },
    })
  })

  it("works a type out again when the owner first writes to the sender", async () => {
    const support: FakeMail = mail(["Support", "support@vendor.example.com"], "Ticket 77 updated")
    const reply: FakeMail = mail(["Me", ME], "Re: Ticket 77", {
      to: [[null, "support@vendor.example.com"]],
      sent: true,
    })
    const path = storePath()
    const { store } = await synced([support], path)
    expect((await store.mail.emails({ types: ["account_notice"] })).map(({ subject }) => subject)).toEqual([
      "Ticket 77 updated",
    ])

    await syncMail(fakeMailSource({ messages: [support, reply] }), store, {
      account: { address: ME },
      since: SINCE,
      now: () => NOW,
    })

    expect((await store.mail.emails({ types: ["personal"] })).map(({ subject }) => subject).sort()).toEqual([
      "Re: Ticket 77",
      "Ticket 77 updated",
    ])
  })

  it("works a type out again when its sender becomes a bot of an organization with a sector", async () => {
    const { store } = await synced([
      mail(["9GAG", "notifications@9gag.com"], "Someone replied to your comment", {
        extraHeaders: ["List-Unsubscribe: <mailto:leave@9gag.com>", "Return-Path: <>"],
      }),
    ])
    expect(await typed(store)).toMatchObject({
      "Someone replied to your comment": { type: "account_notice", signal: "automated-address" },
    })

    await store.people.list({ kind: "all", limit: 10 })

    expect(await typed(store)).toMatchObject({
      "Someone replied to your comment": { type: "social_notification", signal: "sector:social" },
    })
  })

  it("reads schema.org markup in a kept HTML body", async () => {
    const path = storePath()
    const store = await openStore({ path })
    handles.push(store)
    const accountId = await store.accounts.saveAccount({ provider: "email", account: ME }, { name: null })
    const html = (type: string) =>
      `<html><script type="application/ld+json">{"@context":"http://schema.org","@type":"${type}"}</script></html>`
    const email = (id: string, subject: string, from: string, type: string) => ({
      externalId: `<${id}@test.example.com>`,
      subject,
      from: { address: from, name: null },
      to: [{ address: ME, name: null }],
      sentAt: NOW,
      receivedAt: NOW,
      bodyText: null,
      bodyHtml: html(type),
    })
    await store.mail.saveThread({
      accountId,
      externalId: "t1",
      now: NOW,
      emails: [
        email("a", "Trip", "news@air.example.com", "FlightReservation"),
        email("b", "Hello", "news@shop.example.com", "Order"),
      ],
    })

    expect(await typed(store)).toMatchObject({
      Trip: { type: "travel", signal: "schema:FlightReservation" },
      Hello: { type: "order", signal: "schema:Order" },
    })
  })
})

describe("what mail sync keeps for the type", () => {
  it("keeps schema.org types and a few values, the calendar method, an auto-reply and List-Post, not the HTML", async () => {
    const order =
      '<html><script type="application/ld+json">{"@context":"http://schema.org","@type":"Order",' +
      '"orderNumber":"A-1001","merchant":{"@type":"Organization","name":"Shop"}}</script><p>Thanks</p></html>'
    const parcel =
      '<div itemscope itemtype="http://schema.org/ParcelDelivery">' +
      '<meta itemprop="trackingNumber" content="TRK-77"></div>'
    const { store } = await synced([
      mail(["Shop", "hello@shop.example.com"], "Thanks", { html: order }),
      mail(["Post", "hello@post.example.com"], "Parcel", { html: parcel }),
      mail(["Kai Example", "kai@corp.example.com"], "Planning", {
        attachment: { name: "invite.ics", mime: "text/calendar", content: "BEGIN:VCALENDAR\r\nMETHOD:CANCEL\r\n" },
      }),
      mail(["Pia Example", "pia@corp.example.com"], "Away until Monday", {
        extraHeaders: ["Auto-Submitted: auto-replied", ...signed("corp.example.com", ["auto-submitted"])],
      }),
      mail(["Rin Example", "rin@lists.example.com"], "Release notes", {
        listId: "dev.lists.example.com",
        extraHeaders: ["List-Post: <mailto:dev@lists.example.com>"],
      }),
    ])

    const kept = Object.fromEntries(
      (await store.mail.emails({ limit: 50 })).map((email) => [email.subject, email.headers]),
    )
    expect(kept.Thanks).toMatchObject({
      "schema-types": ["Order", "Organization"],
      "schema-fields": { orderNumber: "A-1001" },
    })
    expect(kept.Parcel).toMatchObject({
      "schema-types": ["ParcelDelivery"],
      "schema-fields": { trackingNumber: "TRK-77" },
    })
    expect(kept.Planning).toMatchObject({ "calendar-method": "cancel" })
    expect(kept["Away until Monday"]).toMatchObject({ "auto-replied": true })
    expect(kept["Release notes"]).toMatchObject({ "list-post": true })
    expect(JSON.stringify(kept)).not.toContain("<script")
    expect(await typed(store)).toMatchObject({
      Thanks: { type: "order", signal: "schema:Order" },
      Parcel: { type: "shipping", signal: "schema:ParcelDelivery" },
      Planning: { type: "calendar" },
      "Away until Monday": { type: "auto_reply", signal: "auto-replied" },
      "Release notes": { type: "discussion_list", signal: "list-post" },
    })
  })
})

describe("a sender's mail by type", () => {
  it("lists a shop under its receipts and under its broadcasts, with all its mail counted", async () => {
    const { store } = await synced([
      mail(["Shop", "shop@store.example.com"], "Thank you for your order #1"),
      mail(["Shop", "shop@store.example.com"], "Thank you for your order #2"),
      mail(["Shop", "shop@store.example.com"], "Winter sale: 30% off", {
        extraHeaders: marketing("store.example.com"),
      }),
      mail(["Pia Lund", "pia@friends.example.com"], "Dinner on Friday?"),
    ])

    const broadcast = await store.mail.mailSenders({ reaches: ["broadcast"] })
    expect(broadcast.total).toBe(1)
    expect(broadcast.items[0]).toMatchObject({
      addresses: ["shop@store.example.com"],
      name: "Shop",
      emails: 3,
      types: { order: 2, promotion: 1 },
      reaches: { direct: 2, broadcast: 1 },
    })
    expect(broadcast.items[0]?.ref).toMatch(/^(person|bot):\d+$/)
    const orders = await store.mail.mailSenders({ types: ["order"] })
    expect(orders.items.map(({ addresses }) => addresses)).toEqual([["shop@store.example.com"]])
    expect((await store.mail.mailSenders()).total).toBe(2)
  })

  it("answers a type filter from a read-only open of a store upgraded before its mail was typed", async () => {
    const path = storePath()
    const { store } = await synced(
      [
        mail(["Shop", "shop@store.example.com"], "Thank you for your order #9"),
        mail(["Pia Lund", "pia@friends.example.com"], "Dinner on Friday?"),
      ],
      path,
    )
    await store.close()
    handles.splice(handles.indexOf(store), 1)
    const raw = await openCache(path)
    handles.push(raw)
    // Sync types its mail as it saves it; a store upgraded from before version 76 has none typed.
    raw.exec("UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL")
    expect(Number(raw.prepare("SELECT count(*) AS n FROM emails WHERE mail_type IS NULL").get()?.n)).toBe(2)
    const readOnly = await openStore({ path, readOnly: true })
    handles.push(readOnly)

    expect((await readOnly.mail.emails({ types: ["order"] })).map(({ subject }) => subject)).toEqual([
      "Thank you for your order #9",
    ])
    expect((await readOnly.mail.mailSenders({ types: ["personal"] })).items.map(({ name }) => name)).toEqual([
      "Pia Lund",
    ])
    expect(Number(raw.prepare("SELECT count(*) AS n FROM emails WHERE mail_type IS NULL").get()?.n)).toBe(2)
  })

  it("indexes and types mail as it saves it, and a sync finishes what an upgrade left untyped", async () => {
    const path = storePath()
    const messages = [
      mail(["Shop", "shop@store.example.com"], "Thank you for your order #12"),
      mail(["Pia Lund", "pia@friends.example.com"], "Dinner on Friday?"),
    ]
    const { store } = await synced(messages, path)
    const raw = await openCache(path)
    handles.push(raw)
    const count = (sql: string) => Number(raw.prepare(sql).get()?.n)
    const untyped = () => count("SELECT count(*) AS n FROM emails WHERE mail_type IS NULL")
    expect(untyped()).toBe(0)
    expect(count("SELECT count(*) AS n FROM email_index_pending")).toBe(0)
    expect(count("SELECT count(*) AS n FROM email_words")).toBe(2)

    raw.exec("UPDATE emails SET mail_type = NULL, reach = NULL, type_signal = NULL")
    await syncMail(fakeMailSource({ messages }), store, { account: { address: ME }, since: SINCE, now: () => NOW })
    expect(untyped()).toBe(0)
  })
})
