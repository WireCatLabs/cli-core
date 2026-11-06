import { describe, expect, it } from "vitest"
import { toTelegramHtml } from "./telegram-html.js"

describe("Markdown to Telegram HTML", () => {
  it.each([
    ["# Title", "<b>Title</b>"],
    ["### A **big** one", "<b>A big one</b>"],
    ["a **bold** and *slanted* and _also_", "a <b>bold</b> and <i>slanted</i> and <i>also</i>"],
    ["use `x < y` here", "use <code>x &lt; y</code> here"],
    ["[site](https://example.com/a_b?x=1&y=2)", '<a href="https://example.com/a_b?x=1&amp;y=2">site</a>'],
    ["- one\n  - two\n* three", "• one\n  • two\n• three"],
    ["1. one\n2. two", "1. one\n2. two"],
    ["a < b & c > d", "a &lt; b &amp; c &gt; d"],
    ["snake_case_name and 2*3*4", "snake_case_name and 2*3*4"],
    ["---", "──────"],
    ["```js\nlet a = 1 < 2\n```", "<pre>let a = 1 &lt; 2</pre>"],
    ["[bad](javascript:alert(1))", "[bad](javascript:alert(1))"],
  ])("turns %j into %j", (markdown, html) => {
    expect(toTelegramHtml(markdown)).toBe(html)
  })

  it("keeps code, links and markup inside them untouched", () => {
    expect(toTelegramHtml("`**not bold**` and [**x**](https://e.example)")).toBe(
      '<code>**not bold**</code> and <a href="https://e.example">**x**</a>',
    )
  })

  it("turns a table into label lines", () => {
    const table = "| Name | Due | Owner |\n|---|---|---|\n| Alpha | Mon | Ann |\n| Beta | Tue | Bob |"
    expect(toTelegramHtml(`Before\n${table}\nAfter`)).toBe(
      "Before\n• <b>Alpha</b>: Due: Mon · Owner: Ann\n• <b>Beta</b>: Due: Tue · Owner: Bob\nAfter",
    )
    expect(toTelegramHtml("| k | v |\n|---|---|\n| a | 1 |")).toBe("• <b>a</b>: 1")
  })
})
