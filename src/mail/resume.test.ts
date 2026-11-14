import { describe, expect, it } from "vitest"
import { rulesKey } from "./resume.js"
import type { MailRule } from "./rules.js"

const rule = (match: MailRule["match"], more: Partial<MailRule> = {}): MailRule => ({
  match,
  action: "skip",
  decided_at: "2026-10-14T00:00:00.000Z",
  ...more,
})

describe("the rules a resumed mail sync was made under", () => {
  it("change with any match field, the action or protection, and not with a reason, a date or the key order", () => {
    const base = rulesKey([rule({ domain: "shop.example" })])

    for (const changed of [
      [rule({ domain: "shop.example", subject: "receipt" })],
      [rule({ domain: "shop.example", to: "me@example.test" })],
      [rule({ domain: "shop.example" }, { action: "envelope" })],
      [rule({ domain: "shop.example" }, { protected: true })],
    ])
      expect(rulesKey(changed)).not.toBe(base)
    expect(rulesKey([rule({ domain: "shop.example" }, { decided_at: "2026-11-01T00:00:00.000Z" })])).toBe(base)
    expect(rulesKey([rule({ subject: "a", domain: "b" })])).toBe(rulesKey([rule({ domain: "b", subject: "a" })]))
  })
})
