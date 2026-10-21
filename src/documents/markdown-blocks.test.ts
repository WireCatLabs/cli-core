import { describe, expect, it } from "vitest"
import { blockKey, blockShape } from "./blocks.js"
import { markdownBlocks } from "./markdown-blocks.js"

describe("markdownBlocks", () => {
  it("maps every block kind a provider writes natively", async () => {
    const blocks = await markdownBlocks(`# Title

Some **bold**, *italic*, ~~gone~~, \`code\` and a [link](https://example.invalid/a).

- one
  - nested
1. first
- [ ] open
- [x] done

\`\`\`js
const x = 1
\`\`\`

> quoted

| a | b |
|---|---|
| 1 | 2 |

---

![chart](https://example.invalid/chart.png)
`)
    expect(blocks).toEqual([
      { kind: "heading", level: 1, inlines: [{ text: "Title" }] },
      {
        kind: "paragraph",
        inlines: [
          { text: "Some " },
          { text: "bold", bold: true },
          { text: ", " },
          { text: "italic", italic: true },
          { text: ", " },
          { text: "gone", strike: true },
          { text: ", " },
          { text: "code", code: true },
          { text: " and a " },
          { text: "link", link: "https://example.invalid/a" },
          { text: "." },
        ],
      },
      { kind: "item", list: "bullet", depth: 0, inlines: [{ text: "one" }] },
      { kind: "item", list: "bullet", depth: 1, inlines: [{ text: "nested" }] },
      { kind: "item", list: "number", depth: 0, inlines: [{ text: "first" }] },
      { kind: "item", list: "check", depth: 0, checked: false, inlines: [{ text: "open" }] },
      { kind: "item", list: "check", depth: 0, checked: true, inlines: [{ text: "done" }] },
      { kind: "code", language: "js", text: "const x = 1" },
      { kind: "quote", inlines: [{ text: "quoted" }] },
      { kind: "table", header: [[{ text: "a" }], [{ text: "b" }]], rows: [[[{ text: "1" }], [{ text: "2" }]]] },
      { kind: "rule" },
      { kind: "image", url: "https://example.invalid/chart.png", alt: "chart" },
    ])
  })

  it("resolves reference links", async () => {
    expect(await markdownBlocks("See [docs][d].\n\n[d]: https://example.invalid/docs\n")).toEqual([
      {
        kind: "paragraph",
        inlines: [{ text: "See " }, { text: "docs", link: "https://example.invalid/docs" }, { text: "." }],
      },
    ])
  })

  it("gives equal keys to texts that differ only in how runs are split", () => {
    const split = blockKey({
      kind: "paragraph",
      inlines: [{ text: "a", bold: true }, { text: "" }, { text: "b", bold: true }],
    })
    expect(split).toBe(blockKey({ kind: "paragraph", inlines: [{ text: "ab", bold: true }] }))
  })

  it("keeps the tick in the key but not in the shape", async () => {
    const [open] = await markdownBlocks("- [ ] task")
    const [done] = await markdownBlocks("- [x] task")
    if (!open || !done) throw new Error("missing blocks")
    expect(blockKey(open)).not.toBe(blockKey(done))
    expect(blockShape(open)).toBe(blockShape(done))
  })
})
