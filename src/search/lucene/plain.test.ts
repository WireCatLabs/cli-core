import { parseLucene, walkQuery } from "@wirecat/cli-base/query"
import { describe, expect, it } from "vitest"
import { plainQuery } from "./plain.js"
import { QUERY_FIELDS, validateFields } from "./registry.js"
import { MESSAGE_PARSING } from "./types.js"

const parsed = (text: string) => validateFields(parseLucene(text, MESSAGE_PARSING))
const words = (text: string) => walkQuery(parsed(plainQuery(text)).root).map(({ field, value }) => `${field}:${value}`)

const SPECIAL_TEXT = [
  ["time", "meeting at 10:30", ["text:meeting", "text:at", "text:10:30"]],
  ["time in Cyrillic text", "созвон в 14:00", ["text:созвон", "text:в", "text:14:00"]],
  ["word: that names no field", "Answer as HH:MM", ["text:Answer", "text:as", "text:HH:MM"]],
  ["a:b", "a:b", ["text:a:b"]],
  ["trailing colon", "note:", ["text:note:"]],
  ["spaced colon", "a : b", ["text:a", "text:b"]],
  ["URL", "see https://example.com/a?b=1", ["text:see", "text:https://example.com/a?b=1"]],
  ["unbalanced quote", 'say "unfinished', ["text:say", 'text:"unfinished']],
  ["unbalanced opening parenthesis", "(budget review", ["text:(budget", "text:review"]],
  ["unbalanced closing parenthesis", "budget)", ["text:budget)"]],
  ["slash", "and/or", ["text:and/or"]],
  ["trailing backslash", "path\\", ["text:path\\"]],
  ["exclamation", "wow!", ["text:wow!"]],
  ["caret", "x^2", ["text:x^2"]],
  ["spaced caret", "a ^ b", ["text:a", "text:b"]],
  ["emoji beside a word", "party 🎉", ["text:party"]],
  ["tilde", "~home", ["text:~home"]],
  ["tilde after a word", "approx~", ["text:approx~"]],
  ["square brackets", "[draft]", ["text:[draft]"]],
  ["curly brackets", "{draft}", ["text:{draft}"]],
  ["angle brackets", "<tag>", ["text:<tag>"]],
  ["comparison of no field", "a>b", ["text:a>b"]],
  ["equality of no field", "a=b", ["text:a=b"]],
  ["Boolean word alone", "AND", ["text:AND"]],
  ["question mark ending a word", "invoice?", ["text:invoice?"]],
  ["question in Cyrillic", "что с бюджетом?", ["text:что", "text:с", "text:бюджетом?"]],
  ["NOT alone", "NOT", ["text:NOT"]],
] as const

describe("plainQuery", () => {
  it.each(SPECIAL_TEXT)("reads %s as plain words", (_, text, expected) => {
    expect(words(text)).toEqual(expected)
  })

  it.each([
    "budget",
    "#tag user@example.com R&D 50% C++ a|b don't O'Brien",
    "привет",
    "re-review",
    "back\\slash",
    "or not and",
  ])("leaves %s, which already parses, as it is", (text) => {
    expect(plainQuery(text)).toBe(text)
  })

  it("keeps every field's example, Boolean operators, phrases and proximity", () => {
    for (const { example } of QUERY_FIELDS) expect(plainQuery(example)).toBe(example)
    for (const text of [
      '"budget review" AND NOT cancelled',
      '"invoice paid"~3',
      "(alpha OR beta) -gamma +delta",
      "from:(alice OR bob)",
      "text:/pass(port)?/",
      'mentions:"person:12"',
      "date:[2026-01-01 TO 2026-02-01}",
      "invo*",
      "inv?ice",
      "text:invoice?",
      "a ! b",
    ])
      expect(plainQuery(text)).toBe(text)
  })

  it("repairs the plain word and keeps the field query beside it", () => {
    expect(words("from:alice at 14:00")).toEqual(["from:alice", "text:at", "text:14:00"])
    expect(words("subject:10:30")).toEqual(["subject:10:30"])
  })

  it("can run on its own output", () => {
    for (const [, text] of SPECIAL_TEXT) expect(plainQuery(plainQuery(text))).toBe(plainQuery(text))
  })

  it.each(["!!!", "🎉", '""', "?", "()"])("refuses %s, which holds no letter or digit", (text) => {
    expect(() => plainQuery(text)).toThrow("search needs a letter or a digit to look for")
  })

  it("leaves fuzzy search and a field's own mistakes to the search to report", () => {
    expect(plainQuery("alpha~1")).toBe("alpha~1")
    expect(plainQuery("body:/alpha/i")).toBe("body:/alpha/i")
    expect(plainQuery("after:2026-01-01")).toBe("after:2026-01-01")
    expect(plainQuery("kind:nonsense")).toBe("kind:nonsense")
    expect(() => parsed(plainQuery("after:2026-01-01"))).toThrow(/date/)
    expect(() => parsed(plainQuery("kind:nonsense"))).toThrow()
  })
})
