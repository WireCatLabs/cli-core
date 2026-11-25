import { describe, expect, it } from "vitest"
import { type SortRuleFacts, type SortScope, sortIndexOf, sortRuleFor, sortValueOf } from "./sort-rules.js"

let next = 0
const rule = (scope: SortScope, value: string, extra: Partial<SortRuleFacts> = {}): SortRuleFacts => {
  next += 1
  return { id: next, scope, value, author: "owner", overAddresses: false, past: true, createdAt: next, ...extra }
}

const mail = (from: string, extra: { subject?: string; list?: string; at?: number; id?: number } = {}) => ({
  id: extra.id ?? 1,
  from,
  subject: extra.subject ?? null,
  list: extra.list ?? null,
  at: extra.at ?? 1_000,
})

const winner = (rules: SortRuleFacts[], one: ReturnType<typeof mail>) => sortRuleFor(sortIndexOf(rules), one)?.id

describe("which sorting rule decides a mail", () => {
  it("takes the first scope that has one: mail, then list or subject, then address, then domain", () => {
    const domain = rule("domain", "shop.example")
    const address = rule("address", "orders@shop.example")
    const subject = rule("subject", "your order 0")
    const list = rule("list", "deals.shop.example")
    const own = rule("mail", "7")
    const all = [domain, address, subject, list, own]
    expect(
      winner(all, mail("orders@shop.example", { id: 7, subject: "Your order 4411", list: "deals.shop.example" })),
    ).toBe(own.id)
    expect(winner(all, mail("orders@shop.example", { subject: "Your order 4411" }))).toBe(subject.id)
    expect(winner(all, mail("orders@shop.example", { list: "deals.shop.example" }))).toBe(list.id)
    expect(winner(all, mail("orders@shop.example"))).toBe(address.id)
    expect(winner(all, mail("news@mail.shop.example"))).toBe(domain.id)
  })

  it("puts every owner's rule over every program's, at any scope, then the newest", () => {
    const owner = rule("address", "ann@shop.example")
    const program = rule("address", "ann@shop.example", { author: "program" })
    const newer = rule("address", "ann@shop.example")
    expect(winner([owner, program], mail("ann@shop.example"))).toBe(owner.id)
    expect(winner([owner, program, newer], mail("ann@shop.example"))).toBe(newer.id)
    const programMail = rule("mail", "1", { author: "program" })
    const programList = rule("list", "deals.shop.example", { author: "program" })
    const ownerDomain = rule("domain", "shop.example")
    expect(winner([newer, programMail], mail("ann@shop.example"))).toBe(newer.id)
    expect(
      winner([ownerDomain, programMail, programList], mail("bob@shop.example", { list: "deals.shop.example" })),
    ).toBe(ownerDomain.id)
    expect(winner([programMail, programList], mail("bob@shop.example", { list: "deals.shop.example" }))).toBe(
      programMail.id,
    )
  })

  it("lets a program's rule at a subdomain lose to the owner's at the domain", () => {
    const program = rule("domain", "mail.shop.example", { author: "program" })
    const owner = rule("domain", "shop.example")
    expect(winner([program, owner], mail("news@mail.shop.example"))).toBe(owner.id)
  })

  it("lets a domain rule beat the address rules only when it says so", () => {
    const address = rule("address", "ann@shop.example")
    const domain = rule("domain", "shop.example")
    const over = rule("domain", "shop.example", { overAddresses: true })
    expect(winner([address, domain], mail("ann@shop.example"))).toBe(address.id)
    expect(winner([address, over], mail("ann@shop.example"))).toBe(over.id)
  })

  it("matches addresses whole and domains on a label boundary", () => {
    const ann = rule("address", "ann@shop.example")
    const domain = rule("domain", "shop.example")
    expect(winner([ann], mail("joann@shop.example"))).toBeUndefined()
    expect(winner([domain], mail("ann@myshop.example"))).toBeUndefined()
    expect(winner([domain], mail("ann@shop.example.evil.example"))).toBeUndefined()
    expect(winner([domain], mail("ann@a.b.shop.example"))).toBe(domain.id)
  })

  it("leaves mail dated before a rule made for new mail only to the next rule", () => {
    const fresh = rule("address", "ann@shop.example", { past: false, createdAt: 5_000 })
    const domain = rule("domain", "shop.example")
    expect(winner([fresh, domain], mail("ann@shop.example", { at: 4_999 }))).toBe(domain.id)
    expect(winner([fresh, domain], mail("ann@shop.example", { at: 5_000 }))).toBe(fresh.id)
  })

  it("keeps each scope's value in one form", () => {
    expect(sortValueOf("domain", "News.Mail.Shop.co.uk")).toBe("shop.co.uk")
    expect(sortValueOf("domain", "ann@mail.shop.example")).toBe("shop.example")
    expect(sortValueOf("domain", "co.uk")).toBeUndefined()
    expect(sortValueOf("address", "Ann@Shop.Example")).toBe("ann@shop.example")
    expect(sortValueOf("address", "ann@")).toBeUndefined()
    expect(sortValueOf("list", "Deals <Deals.Shop.Example>")).toBe("deals.shop.example")
    expect(sortValueOf("subject", "  Your  ORDER #4411 ")).toBe("your order #0")
    expect(sortValueOf("mail", "0")).toBeUndefined()
  })
})
