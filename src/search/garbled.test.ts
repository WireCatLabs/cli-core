import { describe, expect, it } from "vitest"
import { normalize } from "../store/normalize.js"
import { type GarbledProbe, garbledDistance, widenWords } from "./garbled.js"
import { knownRussianWord } from "./russian-dictionary.js"
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

  it("does not widen a number to another number", () => {
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
    expect(widenWords([probe("риелтор"), probe("циана"), probe("дом")], vocabulary, stems, () => false)).toEqual([
      ["рилторов", "реелтора", "дриелтора"],
      ["цианом"],
      [],
    ])
  })

  it("widens a spelling only when the dictionary does not know it, and another form of the word always", () => {
    const vocabulary = [
      { term: "поговорить", docs: 40 },
      { term: "договора", docs: 1 },
      { term: "дговор", docs: 1 },
    ]
    expect(widenWords([probe("договор")], vocabulary, stems, knownRussianWord)).toEqual([["дговор"]])
    expect(widenWords([probe("циана")], [{ term: "цианом", docs: 3 }], stems, knownRussianWord)).toEqual([["цианом"]])
  })
})

describe("cut-off words", () => {
  it("widens a query word to a cut-off beginning of it, and never to a real shorter word", () => {
    const vocabulary = [
      { term: "може", docs: 30 },
      { term: "после", docs: 260 },
      { term: "отдел", docs: 50 },
    ]
    expect(
      widenWords([probe("может"), probe("последующих"), probe("отдельно")], vocabulary, stems, knownRussianWord),
    ).toEqual([["може"], [], []])
  })
})

describe("knownRussianWord", () => {
  it.each([
    ["поговорить", true],
    ["которыи", true],
    ["еще", true],
    ["александр", true],
    ["реелтора", false],
    ["дриелтора", false],
  ])("%s is %s", (word, known) => {
    expect(knownRussianWord(word)).toBe(known)
  })
})
