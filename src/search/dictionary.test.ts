import { describe, expect, it } from "vitest"
import { fold } from "../store/normalize.js"
import { dictionaryLanguages, knownWord } from "./dictionary.js"

const { known, covers } = knownWord(["russian", "english", "spanish"])
const real = (word: string) => known(fold(word))

describe("knownWord", () => {
  it("**knows a word through its suffixes and prefixes**", () => {
    expect(["running", "happiness", "unhappy", "rewrite", "disagree"].filter(real)).toHaveLength(5)
    expect(["договорились", "квартиры"].filter(real)).toHaveLength(2)
  })

  it("**knows a word folded as the index stores it**, every й and ё at once", () => {
    expect(["австрийский", "ёлка", "canción", "niños", "están", "mañana"].map(fold).filter(known)).toHaveLength(6)
  })

  it("does not know a garbled spelling", () => {
    expect(["meetign", "presupesto", "рилтор"].filter(real)).toEqual([])
  })

  it("covers only the alphabets its languages write in", () => {
    const russian = knownWord(["russian"])
    expect([russian.covers("риелтор"), russian.covers("realtor")]).toEqual([true, false])
    expect([covers("риелтор"), covers("realtor")]).toEqual([true, true])
  })

  it("takes its languages from the store's stemmers", () => {
    expect(dictionaryLanguages({ cyrillic: "russian", latin: "english,spanish" })).toEqual([
      "russian",
      "english",
      "spanish",
    ])
    expect(dictionaryLanguages({ cyrillic: "none", latin: "english" })).toEqual(["english"])
  })
})
