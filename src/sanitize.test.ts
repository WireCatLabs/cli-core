import { describe, expect, it } from "vitest"
import { singleLine, visibleControls } from "./sanitize.js"

// The control characters are the point: these assert that none of them survive into a terminal.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the test
const RAW_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/

describe("visibleControls", () => {
  it.each([
    ["a screen-clear sequence", "Promo\u001b[2K\u001b[1GDELETED", "Promo\\x1b[2K\\x1b[1GDELETED"],
    ["a bell", "ring\u0007", "ring\\x07"],
    ["a lone carriage return", "first\rsecond", "first\\x0dsecond"],
    ["a null byte", "a\u0000b", "a\\x00b"],
    ["an 8-bit CSI", "a\u009bb", "a\\x9bb"],
    ["a right-to-left override", "invoice\u202efdp.exe", "invoice\\u202efdp.exe"],
    ["a directional isolate", "a\u2067b\u2069", "a\\u2067b\\u2069"],
    ["a zero-width space", "pay\u200bpal", "pay\\u200bpal"],
    ["a right-to-left mark", "a\u200fb", "a\\u200fb"],
    ["a byte-order mark", "a\ufeffb", "a\\ufeffb"],
    ["a tag character", "a\u{e0041}b", "a\\u{e0041}b"],
    ["a stray cancel tag", "a\u{e007f}b", "a\\u{e007f}b"],
  ])("makes %s visible", (_name, input, expected) => {
    const output = visibleControls(input)

    expect(output).toBe(expected)
    expect(output).not.toMatch(RAW_CONTROL)
  })

  it.each([
    ["a newline", "one\ntwo"],
    ["a tab", "one\ttwo"],
    ["an accent", "café"],
    ["han characters", "活动"],
    ["an emoji", "🎯 launch"],
    ["an emoji built with the zero-width joiner", "\u{1f468}\u200d\u{1f469}\u200d\u{1f467} family"],
    ["Persian with a zero-width non-joiner", "می\u200cخواهم"],
    ["an empty string", ""],
    ["a subdivision flag", "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}"],
  ])("leaves %s exactly as it was", (_name, input) => {
    expect(visibleControls(input)).toBe(input)
  })

  it("is reusable — the shared regex does not carry state between calls", () => {
    const hostile = "a\u001bb"

    expect([visibleControls(hostile), visibleControls(hostile), visibleControls(hostile)]).toEqual([
      "a\\x1bb",
      "a\\x1bb",
      "a\\x1bb",
    ])
  })
})

describe("singleLine", () => {
  it.each([
    ["a newline", "Alice\n12:34  you", "Alice\\x0a12:34  you"],
    ["a tab", "one\ttwo", "one\\x09two"],
    ["a carriage return", "one\rtwo", "one\\x0dtwo"],
    ["a line separator", "one\u2028two", "one\\u2028two"],
    ["an escape sequence", "a\u001b[2Kb", "a\\x1b[2Kb"],
  ])("keeps %s from breaking the line", (_name, input, expected) => {
    expect(singleLine(input)).toBe(expected)
  })

  it("leaves ordinary text alone", () => {
    expect(singleLine("Мама Иванова 🎯")).toBe("Мама Иванова 🎯")
  })
})
