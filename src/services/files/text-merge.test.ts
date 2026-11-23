import { describe, expect, it } from "vitest"
import { conflictText, mergeable, mergeText } from "./text-merge.js"

const merge = async (path: string, base: string, local: string, remote: string) => {
  const result = await mergeText(path, Buffer.from(base), Buffer.from(local), Buffer.from(remote))
  return "merged" in result ? result.merged.toString() : result
}

describe("mergeText", () => {
  it("merges changes to different lines of a text file and of a CSV", async () => {
    expect(await merge("a.txt", "one\ntwo\nthree\nfour\n", "ONE\ntwo\nthree\nfour\n", "one\ntwo\nthree\nFOUR\n")).toBe(
      "ONE\ntwo\nthree\nFOUR\n",
    )
    expect(await merge("t.csv", "id,n\n1,a\n2,b\n3,c\n", "id,n\n1,A\n2,b\n3,c\n", "id,n\n1,a\n2,b\n3,c\n4,d\n")).toBe(
      "id,n\n1,A\n2,b\n3,c\n4,d\n",
    )
  })

  it("takes the same change made on both sides once", async () => {
    expect(await merge("a.txt", "a\nb\n", "a\nB\n", "a\nB\n")).toBe("a\nB\n")
  })

  it("reports different changes to the same line as a conflict, with each side's text", async () => {
    const result = await merge("a.txt", "a\nb\nc\n", "a\nmine\nc\n", "a\ntheirs\nc\n")
    expect(result).toMatchObject({
      conflicts: [{ kind: "conflict", line: 2, base: "b\n", local: "mine\n", remote: "theirs\n" }],
    })
    if (typeof result === "string") return
    expect(conflictText(result.segments, "disk")).toBe(
      "a\n<<<<<<< local\nmine\n||||||| base\nb\n=======\ntheirs\n>>>>>>> disk\nc\n",
    )
  })

  it("keeps CRLF line endings, a byte-order mark and a missing last newline byte for byte", async () => {
    const base = "﻿one\r\ntwo\r\nthree\r\nfour"
    const merged = await merge("a.txt", base, "﻿ONE\r\ntwo\r\nthree\r\nfour", "﻿one\r\ntwo\r\nthree\r\nFOUR")
    expect(merged).toBe("﻿ONE\r\ntwo\r\nthree\r\nFOUR")
  })

  it("passes bytes of another encoding through unchanged", async () => {
    const latin = (text: string) => Buffer.from(text, "latin1")
    const result = await mergeText("a.txt", latin("café\nx\ny\n"), latin("café!\nx\ny\n"), latin("café\nx\nÿ\n"))
    expect("merged" in result && result.merged.equals(latin("café!\nx\nÿ\n"))).toBe(true)
  })

  it("does not merge a file with NUL bytes", async () => {
    expect(await merge("a.txt", "a\0\nb\n", "A\0\nb\n", "a\0\nB\n")).toHaveProperty("conflicts")
  })

  it("merges a Markdown checklist tick and a text edit on the same item by blocks", async () => {
    const base = "# Plan\n\n- [ ] buy milk\n- [ ] call Anna\n"
    expect(
      await merge(
        "p.md",
        base,
        "# Plan\n\n- [x] buy milk\n- [ ] call Anna\n",
        "# Plan\n\n- [ ] buy oat milk\n- [ ] call Anna\n",
      ),
    ).toBe("# Plan\n\n- [x] buy oat milk\n- [ ] call Anna\n")
  })

  it("never drops a remote change that Markdown blocks cannot see: front matter stays a conflict", async () => {
    const base = "---\ntitle: a\n---\n- [ ] x\n"
    const result = await merge("p.md", base, "---\ntitle: a\n---\n- [x] x\n", "---\ntitle: b\n---\n- [ ] x!\n")
    expect(result).toHaveProperty("conflicts")
  })

  it("leaves Markdown with mixed line endings to the line merge, which never rewrites a line nobody edited", async () => {
    const base = "# Plan\r\n\n- [ ] buy milk\n- [ ] call Anna\n"
    const result = await merge("p.md", base, base.replace("[ ] buy", "[x] buy"), base.replace("milk", "oat milk"))
    expect(result).toHaveProperty("conflicts")
  })

  it("takes only small files of text kinds", () => {
    expect(mergeable("notes/A.MD", 10, 10)).toBe(true)
    expect(mergeable("data.tsv", 1024 * 1024)).toBe(true)
    expect(mergeable("data.tsv", 1024 * 1024 + 1)).toBe(false)
    expect(mergeable("photo.jpg", 10)).toBe(false)
  })
})
