import { describe, expect, it } from "vitest"
import { mailHeadersOf, signedFieldsOf, unfold } from "./headers.js"

const head = (lines: string[]) => unfold(`${lines.join("\r\n")}\r\n`)
const raw = (lines: string[]) => new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\nBody`)

const SIGNATURE = "DKIM-Signature: v=1; d=news.shop.example; s=s1;\r\n h=From:Subject:Auto-Submitted:Feedback-ID; b=x"

describe("signedFieldsOf", () => {
  it("names the fields a passing signature of the From's own domain covers", () => {
    const stamp = "Authentication-Results: mx.google.com; dkim=pass header.i=@news.shop.example header.s=s1"
    expect([...signedFieldsOf(head([SIGNATURE, stamp]), "deals@shop.example")]).toEqual([
      "from",
      "subject",
      "auto-submitted",
      "feedback-id",
    ])
  })

  it("reads a signer named with a local part", () => {
    const stamp = "Authentication-Results: mx.google.com; dkim=pass header.i=bot@news.shop.example"
    expect(signedFieldsOf(head([SIGNATURE, stamp]), "deals@shop.example").has("auto-submitted")).toBe(true)
  })

  it("trusts nothing from another domain's signature, a failed one or a stamp not Gmail's", () => {
    const pass = "Authentication-Results: mx.google.com; dkim=pass header.i=@news.shop.example"
    expect(signedFieldsOf(head([SIGNATURE, pass]), "deals@other.example").size).toBe(0)
    const failed = "Authentication-Results: mx.google.com; dkim=fail header.i=@news.shop.example"
    expect(signedFieldsOf(head([SIGNATURE, failed]), "deals@shop.example").size).toBe(0)
    const foreign = "Authentication-Results: relay.shop.example; dkim=pass header.i=@news.shop.example"
    expect(signedFieldsOf(head([SIGNATURE, foreign]), "deals@shop.example").size).toBe(0)
  })
})

describe("mailHeadersOf", () => {
  it("keeps Auto-Submitted, one-click unsubscribe and Feedback-ID only when signed, and an empty Return-Path", () => {
    const fields = [
      "From: Deals <deals@shop.example>",
      "Return-Path: <>",
      "Auto-Submitted: auto-generated",
      "Feedback-ID: 1:2:shop",
      "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
      SIGNATURE,
      "Authentication-Results: mx.google.com; dkim=pass header.i=@news.shop.example",
    ]
    expect(mailHeadersOf(raw(fields))).toEqual({
      dkim: "pass",
      "auto-submitted": "auto-generated",
      "feedback-id": true,
      "null-return-path": true,
    })
  })

  it("takes an auto-reply's empty Return-Path for no program", () => {
    expect(mailHeadersOf(raw(["From: pia@office.example", "Return-Path: <>", "Auto-Submitted: auto-replied"]))).toEqual(
      {},
    )
  })
})
