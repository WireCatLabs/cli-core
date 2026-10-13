import { describe, expect, it } from "vitest"
import { parseQuery } from "./query.js"

const NOW = new Date(2026, 9, 1, 12).getTime()
const word = (text: string) => ({ kind: "word", text })
const parse = (query: string) => parseQuery(query, { now: NOW, providers: ["telegram", "max"] })

describe("parseQuery", () => {
  it("**requires every word**, as typed", () => {
    expect(parse("квартира Valencia")).toEqual({
      required: [[word("квартира")], [word("Valencia")]],
      excluded: [],
      has: [],
    })
  })

  it('takes "a phrase" and leaves out -word and -"a phrase"', () => {
    expect(parse('"piso compartido" -alquiler -"sin muebles"')).toMatchObject({
      required: [[{ kind: "phrase", words: ["piso", "compartido"] }]],
      excluded: [word("alquiler"), { kind: "phrase", words: ["sin", "muebles"] }],
    })
  })

  it("**binds OR tighter than the implied AND**", () => {
    expect(parse("piso OR flat OR apartment valencia").required).toEqual([
      [word("piso"), word("flat"), word("apartment")],
      [word("valencia")],
    ])
  })

  it("takes the six filters, a quoted value included", () => {
    expect(parse('from:alice chat:"Valencia Expats" has:photo has:link in:all piso')).toEqual({
      required: [[word("piso")]],
      excluded: [],
      from: "alice",
      chat: "Valencia Expats",
      has: ["photo", "link"],
      in: "all",
    })
  })

  it("**counts after: and before: in local days**, or back from now", () => {
    expect(parse("after:2026-01-31 before:7d")).toMatchObject({
      after: new Date(2026, 0, 31).getTime(),
      before: NOW - 7 * 24 * 60 * 60 * 1000,
    })
  })

  it("**reads only these six names as filters**: a link or a time is text", () => {
    expect(parse("https://example.com 12:30 to:me").required).toEqual([
      [word("https://example.com")],
      [word("12:30")],
      [word("to:me")],
    ])
  })

  it("is a list of filters alone when no word is given", () => {
    expect(parse("from:alice after:2026-01-01")).toMatchObject({ required: [], excluded: [], from: "alice" })
  })

  it("**takes in: any messenger the store holds**, and only those", () => {
    expect(parseQuery("piso in:WhatsApp", { now: NOW, providers: ["whatsapp"] }).in).toBe("whatsapp")
    expect(() => parseQuery("piso in:telegram", { now: NOW })).toThrow(
      'in: takes personal, bots, all, messages, mail — not "telegram"',
    )
  })

  it("**takes in: a kind or a provider's alias**, as --source does", () => {
    const providers = ["telegram", "email", "folder"]
    expect(parseQuery("piso in:tg", { now: NOW, providers }).in).toBe("telegram")
    expect(parseQuery("piso in:messages", { now: NOW, providers }).in).toBe("messages")
    expect(parseQuery("piso in:mail", { now: NOW, providers }).in).toBe("email")
    expect(() => parseQuery("piso in:notes", { now: NOW, providers })).toThrow(
      "in:notes names notes, which a message search does not read — search notes does",
    )
    expect(() => parseQuery("piso in:max", { now: NOW, providers })).toThrow('— not "max"')
  })

  it('reads a quoted "OR" and a lower-case or as words', () => {
    expect(parse('this "OR" that or those').required).toHaveLength(5)
  })

  it.each([
    ["-alquiler -piso", "say what to find, not only what to leave out"],
    ["piso OR", "OR needs a word on each side"],
    ["OR piso", "OR needs a word on each side"],
    ["from:alice OR piso", "OR needs a word on each side"],
    ["piso OR -flat", "a word left out cannot be one side of OR"],
    ["from:alice from:bob", "from: is given twice"],
    ["after:yesterday", 'after: takes a day, 2026-01-31, or a count of days back, 7d — not "yesterday"'],
    ["before:2026-02-30", "before: takes a day"],
    ["in:whatsapp", 'in: takes telegram, max, personal, bots, all, messages, mail — not "whatsapp"'],
    ['chat:""', "chat: needs a value"],
  ])("refuses %s", (query, message) => {
    expect(() => parse(query)).toThrow(message)
  })
})
