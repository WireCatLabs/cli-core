import { describe, expect, it } from "vitest"
import { repairConfigText } from "./config-repair.js"

const repaired = (text: string) => {
  const result = repairConfigText(text)
  if (result.state !== "repaired") throw new Error(`expected a repair, got ${JSON.stringify(result)}`)
  return { value: JSON.parse(result.text) as unknown, text: result.text, fixes: result.fixes }
}

describe("repairConfigText", () => {
  it.each([
    [
      "a byte-order mark",
      `${String.fromCharCode(0xfeff)}{"limit": 5}`,
      { limit: 5 },
      [{ line: 1, kind: "byte_order_mark" }],
    ],
    [
      "a trailing comma",
      '{\n  "limit": 5,\n  "list": [1, 2,],\n}',
      { limit: 5, list: [1, 2] },
      [
        { line: 3, kind: "trailing_comma" },
        { line: 3, kind: "trailing_comma" },
      ],
    ],
    [
      "a missing comma between lines",
      '{\n  "a": 1\n  "b": [true\n  false]\n}',
      { a: 1, b: [true, false] },
      [
        { line: 2, kind: "missing_comma" },
        { line: 3, kind: "missing_comma" },
      ],
    ],
    [
      "comments",
      '{\n  // the limit\n  "limit": 5 /* five */\n}',
      { limit: 5 },
      [
        { line: 2, kind: "comment" },
        { line: 3, kind: "comment" },
      ],
    ],
    [
      "an unquoted key",
      "{\n  limit: 5,\n  messages.send: 1\n}",
      { limit: 5, "messages.send": 1 },
      [
        { line: 2, kind: "unquoted_key" },
        { line: 3, kind: "unquoted_key" },
      ],
    ],
    [
      "single quotes",
      "{'name': 'it\\'s \"x\"'}",
      { name: 'it\'s "x"' },
      [
        { line: 1, kind: "single_quotes" },
        { line: 1, kind: "single_quotes" },
      ],
    ],
    [
      "a file cut off after a value",
      '{\n  "a": {\n    "b": "x",\n',
      { a: { b: "x" } },
      [
        { line: 3, kind: "trailing_comma" },
        { line: 4, kind: "missing_closer" },
      ],
    ],
  ])("**repairs %s**, saying on which line", (_, text, value, fixes) => {
    const result = repaired(text)
    expect(result.value).toEqual(value)
    expect(result.fixes).toEqual(fixes)
  })

  it("**keeps key order, numbers and strings as written** and writes the tools' formatting", () => {
    const result = repaired('{"b": 1.50, "2": "\\u00e9", "a": [],}')
    expect(result.text).toBe('{\n  "b": 1.50,\n  "2": "é",\n  "a": []\n}\n')
  })

  it("**says a valid file needs nothing**, even one that is not an object", () => {
    expect(repairConfigText('{"a": 1}')).toEqual({ state: "valid" })
    expect(repairConfigText("[]")).toEqual({ state: "valid" })
  })

  it.each([
    ["two entries on one line", '{"a": 1 "b": 2}', 1],
    ["a duplicate key", '{"m": "deny", "m": "allow",}', 1],
    ["a bare word as a value", "{\n  limit: five\n}", 2],
    ["NaN", '{"a": NaN,}', 1],
    ["a stop after a closing bracket", '{"a": {"b": 1}', 1],
    ["a stop inside a number", '{"limit": 12', 1],
    ["a stop after a key", '{"a": 1, "b"', 1],
    ["a stop inside text", '{"a": "secr', 1],
    ["a stray closer", '{"a": [1}', 1],
    ["two commas", '{"a": 1,, "b": 2}', 1],
    ["text after the object", '{"a": 1,} x', 1],
    ["an open comment", '{"a": 1, /* x', 1],
    ["a top level that is not an object", "[1, 2,]", 1],
    ["garbage", "hello world", 1],
    ["an empty file", "", 1],
    ["a binary file", "\u0000\u0001\u0002PNG", 1],
    ["a line break inside text", '{"a": "x\ny",}', 1],
  ])("**gives up on %s**", (_, text, line) => {
    expect(repairConfigText(text)).toMatchObject({ state: "refused", line })
  })

  it("**never puts a value in its reasons**", () => {
    const result = repairConfigText('{"token": "sk-SENTINEL" "b": 1}')
    expect(JSON.stringify(result)).not.toContain("SENTINEL")
  })
})
