import { describe, expect, it } from "vitest"
import { parseMarkdownSpans } from "./markdown-spans.js"

describe("parseMarkdownSpans", () => {
  it("reads the styles and keeps nested spans in UTF-16 positions", () => {
    expect(parseMarkdownSpans("🧪 **a _b_** __u__ ||s||")).toEqual({
      text: "🧪 a b u s",
      spans: [
        { type: "bold", from: 3, length: 3 },
        { type: "italic", from: 5, length: 1 },
        { type: "underline", from: 7, length: 1 },
        { type: "spoiler", from: 9, length: 1 },
      ],
    })
    expect(parseMarkdownSpans("*bold* ~gone~").spans.map((span) => span.type)).toEqual(["bold", "strike"])
  })

  it("**keeps words, escaped marks and unclosed marks as typed**", () => {
    for (const value of ["file_name_here", "𝒜_x_", "2*3*4", "**open", "++MAX++", "#hashtag", "1. first"])
      expect(parseMarkdownSpans(value)).toEqual({ text: value, spans: [] })
    expect(parseMarkdownSpans("\\*literal\\*")).toEqual({ text: "*literal*", spans: [] })
  })

  it("reads links and multiline quotes without reading inside code", () => {
    expect(parseMarkdownSpans("> **quote**\n> next\nend")).toEqual({
      text: "quote\nnext\nend",
      spans: [
        { type: "blockquote", from: 0, length: 10 },
        { type: "bold", from: 0, length: 5 },
      ],
    })
    expect(parseMarkdownSpans("[**label**](https://example.test/a(b))")).toEqual({
      text: "label",
      spans: [
        { type: "bold", from: 0, length: 5 },
        { type: "link", from: 0, length: 5, url: "https://example.test/a(b)" },
      ],
    })
    expect(parseMarkdownSpans("```ts\n**raw**\r\n```\n")).toEqual({
      text: "**raw**\r\n",
      spans: [{ type: "pre", from: 0, length: 9, language: "ts" }],
    })
    expect(parseMarkdownSpans("`_raw_`")).toEqual({ text: "_raw_", spans: [{ type: "code", from: 0, length: 5 }] })
  })

  it("reads `#` headings at a line's start and a one-line ``` block", () => {
    expect(parseMarkdownSpans("# **Title**\nbody")).toEqual({
      text: "Title\nbody",
      spans: [
        { type: "heading", from: 0, length: 5 },
        { type: "bold", from: 0, length: 5 },
      ],
    })
    expect(parseMarkdownSpans("```mono``` after")).toEqual({
      text: "mono after",
      spans: [{ type: "pre", from: 0, length: 4, language: "" }],
    })
  })

  it("leaves nesting to the messenger: a code span inside bold and a link inside a link both parse", () => {
    expect(parseMarkdownSpans("**`code`**").spans.map((span) => span.type)).toEqual(["bold", "code"])
    expect(
      parseMarkdownSpans("[a [b](https://example.test)](https://example.test)").spans.map((span) => span.type),
    ).toEqual(["link", "link"])
  })

  it("refuses unsafe links and a fence left open", () => {
    for (const text of ["[x](javascript:alert(1))", "[x](file:///tmp/x)", "```js\nx"])
      expect(() => parseMarkdownSpans(text)).toThrow()
  })

  it("bounds adversarial input and the span count", () => {
    expect(parseMarkdownSpans("[".repeat(10000)).text).toHaveLength(10000)
    expect(() => parseMarkdownSpans("**x** ".repeat(101))).toThrow("100")
  })
})
