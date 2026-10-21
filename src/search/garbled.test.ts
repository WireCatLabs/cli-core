import { describe, expect, it } from "vitest"
import { normalize } from "../store/normalize.js"
import { type GarbledProbe, garbledDistance, widenWords } from "./garbled.js"
import { createStemmer, DEFAULT_STEMMERS } from "./stem.js"

const stemmer = createStemmer(DEFAULT_STEMMERS)
const stems = (word: string) => [...new Set(stemmer.explain(word).map((part) => part.stem))]
const probe = (word: string): GarbledProbe => ({ literal: normalize(word), stems: stems(word) })
const reaches = (query: string, word: string) => garbledDistance(probe(query), normalize(word), stems(word)) !== null

describe("garbledDistance", () => {
  it.each([
    ["риелтор", "реелтора"],
    ["риелтор", "рилторов"],
    ["риелтор", "дриелтора"],
    ["риелтор", "риэлтор"],
    ["циана", "цианом"],
    ["Цианом", "циана"],
    ["экспертиза", "експертизу"],
  ])("%s reaches %s", (query, word) => {
    expect(reaches(query, word)).toBe(true)
  })

  it.each([
    ["устав", "установить"],
    ["устав", "устарел"],
    ["устав", "устанут"],
    ["работа", "заботы"],
    ["проверка", "провела"],
    ["десять", "девять"],
    ["девятью", "десятью"],
    ["циан", "цена"],
  ])("%s does not reach %s", (query, word) => {
    expect(reaches(query, word)).toBe(false)
  })

  it("leaves a number's other numbers to the index's prefix match, which still links «семь» to «семьдесят»", () => {
    expect(garbledDistance(probe("семь"), "семьдесят", stems("семьдесят"))).toBeNull()
  })

  it("leaves words the index already finds to the index", () => {
    expect(garbledDistance(probe("риелтор"), "риелтора", stems("риелтора"))).toBeNull()
    expect(garbledDistance(probe("риелтор"), "риелторский", stems("риелторский"))).toBeNull()
  })
})

describe("widenWords", () => {
  it("widens every probe in one pass, nearest first, then the most used", () => {
    const vocabulary = [
      { term: "дриелтора", docs: 1 },
      { term: "реелтора", docs: 2 },
      { term: "рилторов", docs: 5 },
      { term: "цианом", docs: 3 },
      { term: "дом", docs: 9 },
    ]
    expect(widenWords([probe("риелтор"), probe("циана"), probe("дом")], vocabulary, stems)).toEqual([
      ["рилторов", "реелтора", "дриелтора"],
      ["цианом"],
      [],
    ])
  })
})
