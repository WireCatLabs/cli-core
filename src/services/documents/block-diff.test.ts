import { beforeAll, describe, expect, it } from "vitest"
import type { Block } from "../../documents/blocks.js"
import { markdownBlocks } from "../../documents/markdown-blocks.js"
import { diffBlocks, reconcileBlocks } from "./block-diff.js"

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

describe("reconcileBlocks", () => {
  let recorded: Block[] = []
  let lastLocal: Block[] = []
  beforeAll(async () => {
    recorded = await md("# Plan\n\n- [ ] call\n- [ ] write\n")
    lastLocal = recorded
  })

  it("writes the local file when the remote is what the last push left", async () => {
    const local = await md("# Plan\n\n- [ ] call\n- [ ] write\n- [ ] ship\n")
    expect(reconcileBlocks(recorded, recorded, local, lastLocal)).toEqual({
      status: "clean",
      blocks: local,
      ticksKept: 0,
    })
  })

  it("keeps a remote tick across two pushes while the local file changes elsewhere", async () => {
    const ticked = await md("# Plan\n\n- [x] call\n- [ ] write\n")
    const first = reconcileBlocks(recorded, ticked, await md("# Plan v2\n\n- [ ] call\n- [ ] write\n"), lastLocal)
    expect(first).toEqual({ status: "clean", blocks: await md("# Plan v2\n\n- [x] call\n- [ ] write\n"), ticksKept: 1 })
    if (first.status !== "clean") throw new Error("expected a clean push")

    const written = first.blocks
    const localNow = await md("# Plan v3\n\n- [ ] call\n- [ ] write\n")
    const second = reconcileBlocks(written, written, localNow, await md("# Plan v2\n\n- [ ] call\n- [ ] write\n"))
    if (second.status !== "clean") throw new Error("expected a clean push")
    expect(second.blocks).toEqual(await md("# Plan v3\n\n- [x] call\n- [ ] write\n"))
    expect(diffBlocks(written, second.blocks)).toEqual([
      { from: 0, to: 1, blocks: [{ kind: "heading", level: 1, inlines: [{ text: "Plan v3" }] }] },
    ])
  })

  it("lets a tick changed locally win over the remote", async () => {
    const current = await md("# Plan\n\n- [x] call\n- [ ] write\n")
    const local = await md("# Plan\n\n- [ ] call\n- [x] write\n")
    expect(reconcileBlocks(recorded, current, local, lastLocal)).toEqual({
      status: "clean",
      blocks: await md("# Plan\n\n- [x] call\n- [x] write\n"),
      ticksKept: 1,
    })
    const unticked = await md("# Plan\n\n- [ ] call\n- [ ] write\n")
    expect(reconcileBlocks(current, current, unticked, await md("# Plan\n\n- [x] call\n- [ ] write\n"))).toEqual({
      status: "clean",
      blocks: unticked,
      ticksKept: 0,
    })
  })

  it("stops on any remote change other than a tick", async () => {
    const current = await md("# Plan\n\n- [ ] call Ana\n- [ ] write\n")
    expect(reconcileBlocks(recorded, current, recorded, lastLocal)).toEqual({ status: "conflict" })
  })
})
