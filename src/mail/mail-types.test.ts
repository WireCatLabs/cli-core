import { describe, expect, it } from "vitest"
import { type MailTypeInput, mailTypeOf, schemaTypesOf } from "./mail-types.js"

const input = (fields: Partial<MailTypeInput>): MailTypeInput => ({
  from: "someone@example.com",
  subject: "Hello",
  headers: {},
  recipients: 1,
  parts: [],
  schemaTypes: [],
  listSenders: 0,
  ownerWrote: false,
  bot: false,
  sector: null,
  ...fields,
})

const typeOf = (fields: Partial<MailTypeInput>) => {
  const { type, signal } = mailTypeOf(input(fields))
  return `${type} ${signal}`
}

describe("the type of one email", () => {
  it.each([
    [{ from: "security@bank.example.com", subject: "New sign-in" }, "security security-address"],
    [{ from: "security@bank.example.com", headers: { dmarc: "fail" } }, "account_notice automated-address"],
    [{ subject: "Your order has shipped" }, "shipping shipping-subject"],
    [{ subject: "Код подтверждения: 4411" }, "security security-subject"],
    [{ subject: "Tu pedido ha sido enviado" }, "shipping shipping-subject"],
    [{ subject: "Your boarding pass for Friday" }, "travel travel-subject"],
    [{ subject: "Your tickets for Saturday" }, "event_ticket ticket-subject"],
    [{ subject: "Factura de noviembre" }, "bill bill-subject"],
    [{ from: "news@air.example.com", sector: "airline" }, "travel sector:airline"],
    [
      { from: "news@air.example.com", sector: "airline", headers: { "list-unsubscribe": true } },
      "newsletter newsletter-address",
    ],
    [{ from: "hello@post.example.com", sector: "delivery" }, "shipping sector:delivery"],
    [
      { from: "notify@social.example.com", sector: "social", headers: { "list-unsubscribe": true } },
      "social_notification sector:social",
    ],
    [
      { from: "editor@paper.example.com", sector: "news", headers: { precedence: "bulk" } },
      "newsletter newsletter-address",
    ],
    [{ from: "desk@paper.example.com", sector: "news", headers: { precedence: "bulk" } }, "newsletter sector:news"],
    [
      { subject: "Re: order number format", headers: { "list-id": "dev.example.org" }, listSenders: 5 },
      "discussion_list discussion-list",
    ],
    [{ headers: { precedence: "list" } }, "discussion_list precedence-list"],
    [{ headers: { precedence: "list", "list-id": "news.example.org" }, listSenders: 1 }, "newsletter list-id"],
    [{ from: "info@shop.example.com", headers: { "feedback-id": true } }, "promotion marketing-address"],
    [{ from: "x@esp.example.com", headers: { "feedback-id": true }, bot: true }, "promotion feedback-id"],
    [{ from: "x@esp.example.com", headers: { precedence: "junk" }, bot: true }, "promotion bulk-mail"],
    [
      { from: "notifications@tool.example.com", headers: { "list-unsubscribe": true } },
      "account_notice automated-address",
    ],
    [{ subject: "Build failed: main" }, "system_alert alert-subject"],
    [{ headers: { "auto-submitted": "auto-generated" } }, "account_notice auto-submitted"],
    [{ from: "support@vendor.example.com" }, "account_notice automated-address"],
    [{ from: "support@vendor.example.com", ownerWrote: true }, "personal owner-wrote"],
    [{ bot: true }, "other null"],
    [{ headers: { "null-return-path": true } }, "other null"],
    [{ subject: "Automatic reply: away", headers: { "list-unsubscribe": true } }, "newsletter person-sender"],
    [{ parts: ["message/disposition-notification"], ownerWrote: true }, "auto_reply message/disposition-notification"],
    [{ parts: ["application/ics"], ownerWrote: true }, "calendar application/ics"],
  ] as [Partial<MailTypeInput>, string][])("%o is %s", (fields, expected) => {
    expect(typeOf(fields)).toBe(expected)
  })

  it("works reach out per email", () => {
    expect(mailTypeOf(input({ recipients: 0 })).reach).toBe("broadcast")
    expect(mailTypeOf(input({ recipients: 30 })).reach).toBe("group")
    expect(mailTypeOf(input({ recipients: null })).reach).toBe("direct")
    expect(mailTypeOf(input({ headers: { precedence: "list" } })).reach).toBe("group")
  })
})

describe("schema.org types in HTML", () => {
  it("reads JSON-LD and microdata, and stops at an unclosed block", () => {
    const html =
      '<script type="application/ld+json">{"@type":"ParcelDelivery","partOfOrder":{"@type":"Order"}}</script>' +
      '<div itemscope itemtype="http://schema.org/Invoice"></div><script type="application/ld+json">{"@type":"Bus'
    expect(schemaTypesOf(html).sort()).toEqual(["Invoice", "Order", "ParcelDelivery"])
    expect(schemaTypesOf(null)).toEqual([])
  })
})
