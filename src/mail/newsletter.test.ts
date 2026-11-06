import { describe, expect, it } from "vitest"
import { NEWSLETTER_DEFAULTS, newsletterSorter, transactionalCue } from "./newsletter.js"

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

describe("telling a transactional email from its subject and sender", () => {
  const cue = (subject: string, from = "team@shop.example") => transactionalCue({ subject, from })

  it("finds orders, invoices, receipts and shipments in Russian, English and Spanish", () => {
    expect(cue("Ваш заказ отправлен")).not.toBeNull()
    expect(cue("Счёт на оплату")).not.toBeNull()
    expect(cue("Your receipt from Shop")).not.toBeNull()
    expect(cue("Tu pedido ha sido enviado")).not.toBeNull()
    expect(cue("Factura de octubre")).not.toBeNull()
    expect(cue("Thanks, see you soon", "orders@shop.example")).toBe("orders")
    expect(cue("Payment of 1 250 ₽ received")).not.toBeNull()
    expect(cue("Amazon.es: 406-3547475-4115561")).toBe("406-3547475-4115561")
  })

  it("leaves advertising alone, and lets an order's number settle it", () => {
    expect(cue("Order now: Black Friday sale")).toBeNull()
    expect(cue("Заказ со скидкой 300 ₽")).toBeNull()
    expect(cue("Delivery news", "news@shop.example")).toBeNull()
    expect(cue("Заказ № 45120 со скидкой")).not.toBeNull()
    expect(cue("Weekly update")).toBeNull()
  })
})
