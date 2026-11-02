import { describe, expect, it } from "vitest"
import { paymentTitle, validatePayment } from "./payment.js"

const expected = { amount: "1200", currency: "eur", direction: "to_us", state: "expected" }

describe("validatePayment", () => {
  it("keeps the amount as text with two decimals and the currency upper case", () => {
    expect(validatePayment(expected)).toEqual({
      amount: "1200.00",
      currency: "EUR",
      direction: "to_us",
      counterparty: null,
      counterparty_name: null,
      due_at: null,
      state: "expected",
      item: null,
    })
    expect(validatePayment({ ...expected, amount: "15.5" }).amount).toBe("15.50")
    expect(validatePayment({ ...expected, amount: 300 }).amount).toBe("300.00")
    expect(validatePayment({ ...expected, amount: "0099.99" }).amount).toBe("99.99")
  })

  it.each([
    [{ amount: "0" }, "more than 0"],
    [{ amount: "1.234" }, "at most 2 decimals"],
    [{ amount: "1 200" }, "at most 2 decimals"],
    [{ amount: 0.1 + 0.2 }, "at most 2 decimals"],
    [{ amount: "-5" }, "at most 2 decimals"],
    [{ currency: "EURO" }, "ISO 4217"],
    [{ currency: "ZZZ" }, "ISO 4217"],
    [{ direction: "in" }, "direction is one of to_us, from_us"],
    [{ state: "open" }, "state is one of expected, paid, cancelled"],
    [{ due_at: "2026-02-30" }, "ISO date"],
    [{ due_at: "31.10" }, "ISO date"],
    [{ counterparty: "chat:max/1/2" }, "person:, organization: or project:"],
    [{ dueAt: "2026-10-31" }, "no field dueAt"],
  ])("refuses %o", (change, message) => {
    expect(() => validatePayment({ ...expected, ...change })).toThrow(message)
  })
})

describe("paymentTitle", () => {
  it("says the amount, the direction, who, what for, the due day and the state", () => {
    const payment = validatePayment({ ...expected, counterparty_name: "Ana", due_at: "2026-10-31" })
    expect(paymentTitle({ payment })).toBe("1 200 EUR to us from Ana, due 31.10 (expected)")
    const paid = validatePayment({
      amount: "300.50",
      currency: "EUR",
      direction: "from_us",
      counterparty: "person:7",
      item: "September report",
      state: "paid",
    })
    expect(paymentTitle({ payment: paid })).toBe("300.50 EUR from us to person:7 for September report (paid)")
    expect(paymentTitle({ payment: validatePayment({ ...expected, amount: "1250000" }) })).toBe(
      "1 250 000 EUR to us (expected)",
    )
    expect(paymentTitle({ payment: null })).toBe("")
  })
})
