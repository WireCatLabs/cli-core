import { describe, expect, it } from "vitest"
import { markdownBlocks } from "../../documents/markdown-blocks.js"
import { blocksMarkdown, spliceMarkdown } from "./markdown-splice.js"

const splice = async (text: string, wanted: string) => spliceMarkdown(text, await markdownBlocks(wanted))

describe("spliceMarkdown", () => {
  it("rewrites only the changed block and leaves the rest byte for byte", async () => {
    const text = "# Notes\n\n* star bullet\n* another\n\nold line\n\n```ts\nconst a = 1\n```\n"
    expect(await splice(text, "# Notes\n\n- star bullet\n- another\n\nnew **line**\n\n```ts\nconst a = 1\n```\n")).toBe(
      "# Notes\n\n* star bullet\n* another\n\nnew **line**\n\n```ts\nconst a = 1\n```\n",
    )
  })

  it("flips a tick in place", async () => {
    expect(await splice("* [ ] call  \n* [x] write\n", "- [x] call\n- [ ] write\n")).toBe("* [x] call  \n* [ ] write\n")
  })

  it("flips a tick in place even when the next block changed too", async () => {
    expect(await splice("* [ ] call\n\nold\n", "- [x] call\n\nnew\n")).toBe("* [x] call\n\nnew\n")
  })

  it("inserts an item into a list and a paragraph after it", async () => {
    expect(await splice("- a\n- c\n\nend\n", "- a\n- b\n- c\n\nafter list\n\nend\n")).toBe(
      "- a\n- b\n- c\n\nafter list\n\nend\n",
    )
  })

  it("appends to a file without a final line break and deletes a block", async () => {
    expect(await splice("one\n\ntwo", "one\n\ntwo\n\nthree\n")).toBe("one\n\ntwo\n\nthree\n")
    expect(await splice("one\n\ntwo\n\nthree\n", "one\n\nthree\n")).toBe("one\n\nthree\n")
  })

  it("nests a new item under a parent written with a wider marker", async () => {
    expect(await splice("1. first\n   - a\n2. second\n", "1. first\n   - a\n   - b\n2. second\n")).toBe(
      "1. first\n   - a\n   - b\n2. second\n",
    )
  })

  it("keeps Windows line endings and a byte-order mark", async () => {
    expect(await splice("﻿a\r\n\r\nb\r\n", "a\n\nc\n")).toBe("﻿a\r\n\r\nc\r\n")
  })

  it("rewrites a paragraph together with the images cut from it", async () => {
    const text = "intro ![x](https://example.invalid/x.png)\n\nend\n"
    expect(await splice(text, "intro changed\n\n![x](https://example.invalid/x.png)\n\nend\n")).toBe(
      "intro changed\n\n![x](https://example.invalid/x.png)\n\nend\n",
    )
  })

  it("returns the text unchanged when nothing differs, and nothing when blocks cannot be matched one to one", async () => {
    expect(await splice("a\n", "a\n")).toBe("a\n")
    expect(await spliceMarkdown("a\n\nb\n", await markdownBlocks("a\n"), (blocks) => blocks.slice(1))).toBeUndefined()
  })
})

describe("blocksMarkdown", () => {
  it("writes Markdown that reads back as the same blocks", async () => {
    const source = `# Title *with* \`code\`

Some **bold**, *italic*, ~~gone~~, a [link](https://example.invalid/a b) and 1 * 2 = [x].

- one
  - nested
- [ ] open
- [x] done

1. first

\`\`\`js
const x = "\`\`\`"
\`\`\`

> quoted

| a | b \\| c |
| --- | --- |
| 1 | **2** |

---

![chart](https://example.invalid/chart.png)
`
    const blocks = await markdownBlocks(source)
    expect(await markdownBlocks(blocksMarkdown(blocks))).toEqual(blocks)
  })
})
