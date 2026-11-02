import { describe, expect, it } from "vitest"
import { AGENDA_DEFAULTS } from "./agenda.js"
import { MONEY_DONE, MONEY_REQUEST, moneyClassesOf, PROMISE } from "./money-words.js"

describe("moneyClassesOf", () => {
  it.each([
    ["переведи 50 000 до пятницы", [MONEY_REQUEST]],
    ["please send the invoice", [MONEY_REQUEST]],
    ["envía la factura", [MONEY_REQUEST]],
    ["он перевёл вчера", [MONEY_DONE]],
    ["we paid on Monday", [MONEY_DONE]],
    ["lo he recibido", [MONEY_DONE]],
    ["оплачу в пятницу", [PROMISE]],
    ["I promise it is coming", [PROMISE]],
    ["привет, как дела", []],
  ])("%j", (text, classes) => {
    expect(moneyClassesOf(text)).toEqual(classes)
  })
})

it("exports the agenda thresholds the command uses", () => {
  expect(AGENDA_DEFAULTS).toEqual({ unanswered: 86_400_000, waiting: 7 * 86_400_000 })
})
