import { describe, expect, it } from "vitest"
import { htmlText } from "./markup.js"

const SIZE = 200_000

describe("htmlText", () => {
  it("keeps the visible text: blocks on their own lines, cells tab-separated, entities decoded", () => {
    const page =
      "<html><head><title>hidden</title><STYLE>p{}</STYLE ></head><body><!-- note --><h1>Report</h1>" +
      "<p class=lead>One &amp; two&nbsp;&#1046;&#x416; &bogus;</p>   \n<script>alert(1)</script>" +
      "<table><tr><td>a</td><th>b</th></tr></table><svg><text>chart</text></svg><br/>end</body></html>"
    expect(htmlText(page)).toBe("Report\n\nOne & two\u00a0ЖЖ &bogus;\n\na\tb\n\nend")
  })

  it("keeps an unclosed comment, script or tag as text, and still drops what closes after it", () => {
    expect(htmlText("a <!-- open <b>c</b>")).toBe("a c")
    expect(htmlText("a<script>x<style>y</style>z")).toBe("axz")
    expect(htmlText("a <b c")).toBe("a <b c")
  })

  it.each([
    ["<", "<".repeat(SIZE)],
    ["<a", "<a".repeat(SIZE / 2)],
    ["<p", "<p".repeat(SIZE / 2)],
    ["<!--", "<!--".repeat(SIZE / 4)],
    ["<script ", "<script ".repeat(SIZE / 8)],
    ["<script>", "<script>".repeat(SIZE / 8)],
    ["<style> then <script>", `<style>${"<script>".repeat(SIZE / 8)}`],
    ["spaces", `${" \u00a0\t".repeat(SIZE / 3)}x`],
  ])("strips %s repeated to 200k characters in linear time", (_name, hostile) => {
    // Each of these took seconds at this size when a regex rescanned to the end from every `<`.
    const started = performance.now()
    htmlText(hostile)
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})
