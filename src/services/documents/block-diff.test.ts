import { describe, expect, it } from "vitest"
import { markdownBlocks } from "../../documents/markdown-blocks.js"
import { diffBlocks, mergeBlocks } from "./block-diff.js"

const md = (text: string) => markdownBlocks(text)

describe("diffBlocks", () => {
  it("touches only the changed block", async () => {
    const base = await md("# A\n\nkeep one\n\nold\n\nkeep two\n")
    const next = await md("# A\n\nkeep one\n\nnew\n\nkeep two\n")
    expect(diffBlocks(base, next)).toEqual([
      { from: 2, to: 3, blocks: [{ kind: "paragraph", inlines: [{ text: "new" }] }] },
    ])
  })

  it("reports inserts and deletes as empty ranges and empty replacements", async () => {
    const base = await md("a\n\nb\n\nc\n")
    expect(diffBlocks(base, await md("a\n\nx\n\nb\n\nc\n"))).toEqual([
      { from: 1, to: 1, blocks: [{ kind: "paragraph", inlines: [{ text: "x" }] }] },
    ])
    expect(diffBlocks(base, await md("a\n\nc\n"))).toEqual([{ from: 1, to: 2, blocks: [] }])
  })

  it("finds nothing to do for an identical document", async () => {
    const base = await md("- [x] a\n- [ ] b\n")
    expect(diffBlocks(base, await md("- [x] a\n- [ ] b\n"))).toEqual([])
  })
})

describe("mergeBlocks", () => {
  const base = "# Plan\n\n- [ ] call\n- [ ] write\n\nnotes\n"
  const merge = async (local: string, remote: string, keep?: "local" | "remote" | "both", from = base) =>
    mergeBlocks(await md(from), await md(from), await md(local), await md(remote), keep)

  it("takes each side's change when they touch different blocks", async () => {
    const merged = await merge("# Plan v2\n\n- [ ] call\n- [ ] write\n\nnotes\n", `${base}\nadded in Google\n`)
    expect(merged).toEqual({
      status: "clean",
      blocks: await md("# Plan v2\n\n- [ ] call\n- [ ] write\n\nnotes\n\nadded in Google\n"),
      conflicts: [],
    })
  })

  it("merges the same change made on both sides once", async () => {
    const both = "# Plan\n\n- [ ] call\n- [ ] write\n\nnotes, edited\n"
    expect(await merge(both, both)).toEqual({ status: "clean", blocks: await md(both), conflicts: [] })
  })

  it("keeps a tick from one side and a text edit from the other on the same item", async () => {
    const merged = await merge(
      "# Plan\n\n- [ ] call Ana\n- [ ] write\n\nnotes\n",
      "# Plan\n\n- [x] call\n- [ ] write\n\nnotes\n",
    )
    expect(merged).toEqual({
      status: "clean",
      blocks: await md("# Plan\n\n- [x] call Ana\n- [ ] write\n\nnotes\n"),
      conflicts: [],
    })
  })

  it("lets each tick follow the side that changed it", async () => {
    const merged = await merge(
      "# Plan\n\n- [ ] call\n- [x] write\n\nnotes\n",
      "# Plan\n\n- [x] call\n- [ ] write\n\nnotes\n",
    )
    expect(merged).toEqual({
      status: "clean",
      blocks: await md("# Plan\n\n- [x] call\n- [x] write\n\nnotes\n"),
      conflicts: [],
    })
  })

  it("keeps a remote tick the local file never had once neither side changes it", async () => {
    const remote = await md("# Plan\n\n- [x] call\n- [ ] write\n")
    const local = await md("# Plan v3\n\n- [ ] call\n- [ ] write\n")
    const merged = mergeBlocks(await md("# Plan\n\n- [ ] call\n- [ ] write\n"), remote, local, remote)
    expect(merged).toEqual({
      status: "clean",
      blocks: await md("# Plan v3\n\n- [x] call\n- [ ] write\n"),
      conflicts: [],
    })
  })

  it("reports a block both sides changed differently, and settles it when told which to keep", async () => {
    const local = "# Plan\n\n- [ ] call\n- [ ] write\n\nnotes from the laptop\n"
    const remote = "# Plan\n\n- [ ] call\n- [ ] write\n\nnotes from Google\n"
    const conflict = {
      base: await md("notes\n"),
      local: await md("notes from the laptop\n"),
      remote: await md("notes from Google\n"),
    }
    expect(await merge(local, remote)).toEqual({ status: "conflict", conflicts: [conflict] })
    expect(await merge(local, remote, "remote")).toEqual({
      status: "clean",
      blocks: await md(remote),
      conflicts: [conflict],
    })
    expect(await merge(local, remote, "both")).toEqual({
      status: "clean",
      blocks: await md("# Plan\n\n- [ ] call\n- [ ] write\n\nnotes from the laptop\n\nnotes from Google\n"),
      conflicts: [conflict],
    })
  })

  it("treats two inserts at the same place as a conflict unless they are equal", async () => {
    const merged = await merge(`${base}\nmine\n`, `${base}\ntheirs\n`)
    expect(merged.status).toBe("conflict")
  })

  it("refuses to merge when the two sides of the last sync do not hold the same blocks", async () => {
    expect(mergeBlocks(await md("a\n"), await md("b\n"), await md("a\n"), await md("b\n"))).toEqual({
      status: "unaligned",
    })
  })
})
