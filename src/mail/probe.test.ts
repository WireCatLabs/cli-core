import { describe, expect, it } from "vitest"
import type { MailHeaders } from "./headers.js"
import { probeMail } from "./probe.js"
import { decide, type MailRule } from "./rules.js"
import type { Listed } from "./source.js"

const email = (n: number, headers: MailHeaders, more: Partial<Listed> = {}): Listed => ({
  uid: String(n),
  messageId: String(n),
  threadId: String(n),
  receivedAt: `20${10 + (n % 10)}-01-01T00:00:00.000Z`,
  size: 100,
  seen: n % 2 === 0,
  headers,
  ...more,
})

describe("probeMail", () => {
  it("groups by list or sender and suggests skipping only large, bulk, never-answered groups", () => {
    const news = { from: "news@shop.example", to: [], listId: "news.shop.example", bulk: true }
    const alerts = { from: "alerts@bank.example", to: [], bulk: true }
    const items = [
      ...Array.from({ length: 25 }, (_, n) => email(n, news)),
      ...Array.from({ length: 25 }, (_, n) => email(100 + n, alerts)),
      ...Array.from({ length: 3 }, (_, n) => email(200 + n, { from: "alice@example.test", to: [], bulk: false })),
      email(300, { from: "owner@example.test", to: ["alerts@bank.example"], bulk: false }, { labels: ["Sent"] }),
    ]

    const probe = probeMail(items, 10)

    expect(probe).toMatchObject({ emails: 54, sent: 1, groups: 3, withoutHeaders: 0 })
    expect(
      probe.items.map(({ listId, from, emails, replied, suggest }) => ({ listId, from, emails, replied, suggest })),
    ).toEqual([
      { listId: "news.shop.example", from: "news@shop.example", emails: 25, replied: false, suggest: "skip" },
      { listId: null, from: "alerts@bank.example", emails: 25, replied: true, suggest: null },
      { listId: null, from: "alice@example.test", emails: 3, replied: false, suggest: null },
    ])
    expect(probe.items[0]).toMatchObject({ bulk: 1, unread: 0.48, firstYear: 2010, lastYear: 2019, bytes: 2500 })
  })
})

describe("decide", () => {
  const rule = (match: MailRule["match"], action: MailRule["action"]): MailRule => ({
    match,
    action,
    decided_at: "2026-10-14T00:00:00.000Z",
  })
  const rules = [rule({ domain: "shop.example" }, "skip"), rule({ from: "orders@mail.shop.example" }, "keep")]

  it("skips a domain and its subdomains, and lets a keep win over a skip", () => {
    expect(decide(rules, { headers: { from: "news@mail.shop.example", to: [], bulk: true } })?.action).toBe("skip")
    expect(decide(rules, { headers: { from: "orders@mail.shop.example", to: [], bulk: true } })?.action).toBe("keep")
    expect(decide(rules, { headers: { from: "alice@notshop.example", to: [], bulk: false } })).toBeUndefined()
    expect(decide(rules, undefined)).toBeUndefined()
  })

  it("records mail an envelope rule and a skip rule both match, and keeps mail a keep rule matches", () => {
    const layered = [...rules, rule({ list_id: "deals.shop.example" }, "envelope")]
    const deal = { from: "news@mail.shop.example", to: [], listId: "deals.shop.example", bulk: true }

    expect(decide(layered, { headers: deal })).toMatchObject({
      action: "envelope",
      match: { list_id: "deals.shop.example" },
    })
    expect(decide(layered, { headers: { ...deal, from: "orders@mail.shop.example" } })?.action).toBe("keep")
  })
})
