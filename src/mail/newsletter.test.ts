import { describe, expect, it } from "vitest"
import { NEWSLETTER_DEFAULTS, newsletterSorter } from "./newsletter.js"

const sort = newsletterSorter()
const verdict = (subject: string, text = "", from = "team@shop.example") => sort({ subject, text, from }).verdict

describe("telling a newsletter from bulk mail about something of yours", () => {
  it("leaves out advertising in Russian, English and Spanish", () => {
    expect(verdict("Скидки до 50% только сегодня")).toBe("newsletter")
    expect(verdict("Black Friday: 30% off everything")).toBe("newsletter")
    expect(verdict("Descuentos de otoño")).toBe("newsletter")
    expect(verdict("How to tell if a startup has a moat", "", "lenny@substack.com")).toBe("newsletter")
  })

  it("keeps orders, invoices, site requests and replies, whatever else they say", () => {
    expect(verdict("Ваш заказ отправлен — скидка на следующий")).toBe("excerpt")
    expect(verdict("Invoice INV-2026 for October", "", "billing@news.example")).toBe("excerpt")
    expect(verdict("Новая заявка", "Скидка 10%\nЗаявка № 4512")).toBe("excerpt")
    expect(verdict("Re: weekly digest of the project")).toBe("excerpt")
  })

  it("gives the agent what it cannot tell, cut at a word", () => {
    const sorted = newsletterSorter({ ...NEWSLETTER_DEFAULTS, excerptChars: 20 })
    expect(sorted({ subject: "Account update", text: "We changed the terms of the service", from: null })).toEqual({
      verdict: "excerpt",
      score: 0,
      cues: [],
      excerpt: "We changed the…",
    })
  })
})
