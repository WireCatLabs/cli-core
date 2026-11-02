import { expect, it } from "vitest"
import { createStemmer } from "../search/stem.js"
import { moneyClassesOf } from "../services/money-words.js"
import { MONEY_DONE, MONEY_WORDS } from "./money-words.js"

it("keeps every stem in one class", () => {
  const english = createStemmer({ cyrillic: "russian", latin: "english" })
  const spanish = createStemmer({ cyrillic: "russian", latin: "spanish" })
  const owners = new Map<string, string>()
  for (const { name, triggers } of MONEY_WORDS) {
    const stems = [
      ...Object.values(triggers).flatMap((words) =>
        words.flatMap((word) => english.stemTokens(word).map((s) => `en:${s}`)),
      ),
      ...triggers.es.flatMap((word) => spanish.stemTokens(word).map((s) => `es:${s}`)),
    ]
    for (const stem of stems) {
      const other = owners.get(stem)
      expect(other === undefined || other === name, `${stem} is in ${other} and ${name}`).toBe(true)
      owners.set(stem, name)
    }
  }
})

it.each([["I transferred the money"], ["we refunded you"], ["pagaré mañana"], ["ya pagué"]])(
  "%j is not a payment made and a request at once",
  (text) => {
    const classes = moneyClassesOf(text)
    expect(classes.includes(MONEY_DONE) && classes.length > 1).toBe(false)
  },
)

it("does not read pagaré as paid", () => {
  expect(moneyClassesOf("pagaré mañana")).not.toContain(MONEY_DONE)
})
