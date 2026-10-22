import { type Block, blockKey, blockShape } from "../../documents/blocks.js"
import type { Keep } from "../../documents/push-model.js"

/** `base[from, to)` is replaced by `blocks`; an empty range is an insert, an empty `blocks` a delete. */
export interface BlockHunk {
  from: number
  to: number
  blocks: Block[]
}

const MAX_CELLS = 4_000_000

/** Longest common subsequence: index pairs [inA, inB] of blocks with equal keys, in order. */
const matches = (a: Block[], b: Block[], keyOf: (block: Block) => string): [number, number][] => {
  const ka = a.map(keyOf)
  const kb = b.map(keyOf)
  let start = 0
  while (start < ka.length && start < kb.length && ka[start] === kb[start]) start++
  let endA = ka.length
  let endB = kb.length
  while (endA > start && endB > start && ka[endA - 1] === kb[endB - 1]) {
    endA--
    endB--
  }
  const rows = endA - start
  const cols = endB - start
  const pairs: [number, number][] = []
  for (let i = 0; i < start; i++) pairs.push([i, i])
  if (rows * cols > MAX_CELLS) {
    // Too large to align: the changed middle is rewritten as one block of edits.
  } else if (rows && cols) {
    const table = new Uint32Array((rows + 1) * (cols + 1))
    for (let i = rows - 1; i >= 0; i--)
      for (let j = cols - 1; j >= 0; j--)
        table[i * (cols + 1) + j] =
          ka[start + i] === kb[start + j]
            ? (table[(i + 1) * (cols + 1) + j + 1] as number) + 1
            : Math.max(table[(i + 1) * (cols + 1) + j] as number, table[i * (cols + 1) + j + 1] as number)
    let i = 0
    let j = 0
    while (i < rows && j < cols) {
      if (ka[start + i] === kb[start + j]) {
        pairs.push([start + i, start + j])
        i++
        j++
      } else if ((table[(i + 1) * (cols + 1) + j] as number) >= (table[i * (cols + 1) + j + 1] as number)) i++
      else j++
    }
  }
  for (let offset = 0; offset < ka.length - endA; offset++) pairs.push([endA + offset, endB + offset])
  return pairs
}

/** The edits that turn `base` into `next`, leaving every unchanged block in place. */
export const diffBlocks = (base: Block[], next: Block[], keyOf: (block: Block) => string = blockKey): BlockHunk[] => {
  const hunks: BlockHunk[] = []
  let a = 0
  let b = 0
  for (const [i, j] of [...matches(base, next, keyOf), [base.length, next.length] as [number, number]]) {
    if (i > a || j > b) hunks.push({ from: a, to: i, blocks: next.slice(b, j) })
    a = i + 1
    b = j + 1
  }
  return hunks
}

/** A stretch both sides changed differently: the blocks it held at the last sync and on each side now. */
export interface BlockConflict {
  base: Block[]
  local: Block[]
  remote: Block[]
}
export type Merged =
  | { status: "clean"; blocks: Block[]; conflicts: BlockConflict[] }
  | { status: "conflict"; conflicts: BlockConflict[] }
  | { status: "unaligned" }

const isCheck = (block: Block | undefined): block is Extract<Block, { kind: "item" }> =>
  block?.kind === "item" && block.list === "check"
const sameKeys = (a: Block[], b: Block[]) =>
  a.length === b.length && a.every((block, index) => blockKey(block) === blockKey(b[index] as Block))
/** Two hunks touch the same stretch: their ranges overlap, both insert at one point, or one inserts inside the other. */
const touches = (a: BlockHunk, b: BlockHunk) =>
  Math.max(a.from, b.from) < Math.min(a.to, b.to) ||
  a.from === b.from ||
  (a.from === a.to && b.from < a.from && a.from < b.to) ||
  (b.from === b.to && a.from < b.from && b.from < a.to)
const applied = (base: Block[], from: number, to: number, hunks: BlockHunk[]) => {
  let out: Block[] = []
  let at = from
  for (const hunk of hunks) {
    out = out.concat(base.slice(at, hunk.from), hunk.blocks)
    at = hunk.to
  }
  return out.concat(base.slice(at, to))
}

/**
 * Three-way merge of a document changed on both sides since the last sync. `baseLocal` and `baseRemote` are each
 * side as the last sync left it; they hold the same blocks, though a tick may differ. Blocks line up by their
 * shape, so a checklist tick never collides with a text edit: each tick follows the side that changed it, the
 * remote when neither did. A stretch both sides changed differently is a conflict, settled by `keep` when given.
 */
export const mergeBlocks = (
  baseLocal: Block[],
  baseRemote: Block[],
  local: Block[],
  remote: Block[],
  keep?: Keep,
): Merged => {
  if (
    baseLocal.length !== baseRemote.length ||
    baseLocal.some((block, index) => blockShape(block) !== blockShape(baseRemote[index] as Block))
  )
    return { status: "unaligned" }
  const tagged = [
    ...diffBlocks(baseLocal, local, blockShape).map((hunk) => ({ ...hunk, side: "local" as const })),
    ...diffBlocks(baseRemote, remote, blockShape).map((hunk) => ({ ...hunk, side: "remote" as const })),
  ].sort((a, b) => a.from - b.from || a.to - b.to)
  const clusters: (typeof tagged)[] = []
  for (const hunk of tagged) {
    const last = clusters.at(-1)
    if (last?.some((other) => touches(other, hunk))) last.push(hunk)
    else clusters.push([hunk])
  }

  const unchangedLocal = new Map(matches(baseLocal, local, blockShape))
  const unchangedRemote = new Map(matches(baseRemote, remote, blockShape))
  /** A base block neither side replaced: it keeps its place and takes the tick of the side that changed it. */
  const kept = (index: number): Block => {
    const base = baseLocal[index] as Block
    const mine = local[unchangedLocal.get(index) ?? -1]
    const theirs = remote[unchangedRemote.get(index) ?? -1]
    if (!isCheck(base) || !isCheck(mine) || !isCheck(theirs)) return mine ?? theirs ?? base
    const changedHere = Boolean(mine.checked) !== Boolean(base.checked)
    return { ...mine, checked: changedHere ? Boolean(mine.checked) : Boolean(theirs.checked) }
  }
  /** One side's replacement, with the other side's tick carried onto items it edited in place. */
  const oneSide = (hunk: BlockHunk & { side: "local" | "remote" }): Block[] => {
    if (hunk.to - hunk.from !== hunk.blocks.length) return hunk.blocks
    return hunk.blocks.map((block, offset) => {
      const index = hunk.from + offset
      const base = (hunk.side === "local" ? baseRemote : baseLocal)[index]
      const other =
        hunk.side === "local" ? remote[unchangedRemote.get(index) ?? -1] : local[unchangedLocal.get(index) ?? -1]
      const own = (hunk.side === "local" ? baseLocal : baseRemote)[index]
      if (!isCheck(block) || !isCheck(base) || !isCheck(other) || !isCheck(own)) return block
      if (Boolean(block.checked) !== Boolean(own.checked) || Boolean(other.checked) === Boolean(base.checked))
        return block
      return { ...block, checked: Boolean(other.checked) }
    })
  }

  let blocks: Block[] = []
  const conflicts: BlockConflict[] = []
  let at = 0
  for (const cluster of clusters) {
    const from = cluster.reduce((low, hunk) => Math.min(low, hunk.from), Number.POSITIVE_INFINITY)
    const to = cluster.reduce((high, hunk) => Math.max(high, hunk.to), 0)
    for (; at < from; at++) blocks.push(kept(at))
    at = to
    const mine = cluster.filter((hunk) => hunk.side === "local")
    const theirs = cluster.filter((hunk) => hunk.side === "remote")
    if (!theirs.length || !mine.length) {
      let cursor = from
      for (const hunk of cluster) {
        for (; cursor < hunk.from; cursor++) blocks.push(kept(cursor))
        blocks = blocks.concat(oneSide(hunk))
        cursor = hunk.to
      }
      for (; cursor < to; cursor++) blocks.push(kept(cursor))
      continue
    }
    const localSide = applied(baseLocal, from, to, mine)
    const remoteSide = applied(baseRemote, from, to, theirs)
    if (sameKeys(localSide, remoteSide)) {
      blocks = blocks.concat(localSide)
      continue
    }
    conflicts.push({ base: baseLocal.slice(from, to), local: localSide, remote: remoteSide })
    blocks = blocks.concat(keep === "remote" ? [] : localSide, keep === "local" ? [] : remoteSide)
  }
  for (; at < baseLocal.length; at++) blocks.push(kept(at))
  if (conflicts.length && !keep) return { status: "conflict", conflicts }
  return { status: "clean", blocks, conflicts }
}
