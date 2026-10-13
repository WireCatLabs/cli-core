import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { compileAutomaton, foldRegex, wildcardPattern } from "./automaton.js"

interface Fixture {
  pattern: string
  parsed: boolean
  matches?: string[]
}
const fixtures: Fixture[] = JSON.parse(readFileSync(new URL("./regex-reference.json", import.meta.url), "utf8"))
const samples = [
  "",
  "alpha",
  "beta",
  "a",
  "aa",
  "b",
  "ab",
  "abc",
  "123",
  "d",
  "a1",
  "_",
  "α",
  "😀",
  " ",
  "\t",
  "\n",
  "a/b",
  "a.b",
  "*",
  "^a$",
  "aaaaab",
  "A",
]
const unsupported = new Set(["a&b", "~a", "<01-12>", "<named>", "[^\\D]", "(?=a)", "(?:a)"])
describe("Lucene 9.12.3 regex subset", () => {
  for (const row of fixtures)
    it(`matches upstream: ${JSON.stringify(row.pattern)}`, () => {
      if (unsupported.has(row.pattern)) expect(() => compileAutomaton(row.pattern)).toThrow()
      else if (!row.parsed) expect(() => compileAutomaton(row.pattern)).toThrow()
      else {
        const automaton = compileAutomaton(row.pattern)
        expect(samples.filter((sample) => automaton.test(sample))).toEqual(row.matches)
      }
    })
  it("escapes wildcard literals and respects whole-term matching", () => {
    const literal = compileAutomaton(wildcardPattern("a\\*?"))
    expect(literal.test("a*x")).toBe(true)
    expect(literal.test("axx")).toBe(false)
    expect(compileAutomaton(wildcardPattern("alph*")).test("alpha")).toBe(true)
    expect(compileAutomaton(wildcardPattern("alpha")).test("xalpha")).toBe(false)
    expect(() => wildcardPattern("a\\")).toThrow("query.invalid-escape")
  })
  it("bounds pattern size, nesting, repetition/state expansion and total match work", () => {
    expect(() => compileAutomaton("x".repeat(1025))).toThrow("pattern")
    expect(() => compileAutomaton("a{10001}")).toThrow("states")
    expect(() => compileAutomaton("(ab){9999}")).toThrow("states")
    expect(() => compileAutomaton(`${"(".repeat(33)}a${")".repeat(33)}`)).toThrow("depth")
    const matcher = compileAutomaton("(a+)+b")
    expect(() => matcher.test("a".repeat(100), { work: 0, maxWork: 50 })).toThrow("work")
    expect(matcher.test("aaaaab")).toBe(true)
  })
})

describe("folding a text: regex", () => {
  const folded = (pattern: string) => foldRegex(pattern, { start: 0, end: pattern.length })
  const matches = (pattern: string, term: string) => compileAutomaton(folded(pattern)).test(term)
  it("lowercases and strips accents from literals, as the word index does", () => {
    expect(folded("Квартир.*")).toBe("квартир.*")
    expect(matches("Квартир.*", "квартира")).toBe(true)
    expect(matches("счёт", "счет")).toBe(true)
    expect(matches("сче\u0308т", "счет")).toBe(true)
    expect(matches("\\Ё", "е")).toBe(true)
    expect(matches('"AÑO"', "ano")).toBe(true)
    expect(matches("(Año|Mes){1,2}", "anomes")).toBe(true)
    expect(matches("ﬁx+", "fixx")).toBe(true)
    expect(matches("ﬁx+", "fifix")).toBe(false)
  })
  it("folds classes and ranges, and keeps predefined classes and their negation", () => {
    expect(folded("[А-Я]+")).toBe("[а-ик-я]+")
    expect(matches("[А-Я]вартира", "квартира")).toBe(true)
    expect(matches("[^Ё]", "е")).toBe(false)
    expect(matches("[ÀÉ]", "e")).toBe(true)
    expect(folded("\\D\\W\\S")).toBe("\\D\\W\\S")
    expect(matches("\\d+", "42")).toBe(true)
    expect(matches("\\W", "a")).toBe(false)
    expect(matches("[\\-x]", "-")).toBe(true)
  })
  it("refuses what has no single folded form instead of matching nothing", () => {
    expect(() => folded(".\u0301")).toThrow("query.unsupported-regex")
    expect(() => folded("[ﬁ]")).toThrow("body:")
    expect(() => folded("[a-\u{10ffff}]")).not.toThrow()
    expect(() => folded("[A-\u{10ffff}]")).toThrow("the range")
  })
  it("leaves every lowercase reference pattern meaning what it meant", () => {
    for (const row of fixtures.filter(({ pattern, parsed }) => parsed && !unsupported.has(pattern))) {
      if (/[^\p{Ll}\P{L}]|[^\x20-\x7e]/u.test(row.pattern)) continue
      const automaton = compileAutomaton(folded(row.pattern))
      expect(
        samples.filter((sample) => automaton.test(sample)),
        row.pattern,
      ).toEqual(row.matches)
    }
  })
})
