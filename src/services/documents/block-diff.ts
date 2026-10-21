import { type Block, blockKey, blockShape } from "../../documents/blocks.js"

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
export const diffBlocks = (base: Block[], next: Block[]): BlockHunk[] => {
  const hunks: BlockHunk[] = []
  let a = 0
  let b = 0
  for (const [i, j] of [...matches(base, next, blockKey), [base.length, next.length] as [number, number]]) {
    if (i > a || j > b) hunks.push({ from: a, to: i, blocks: next.slice(b, j) })
    a = i + 1
    b = j + 1
  }
  return hunks
}

export type Reconciled = { status: "clean"; blocks: Block[]; ticksKept: number } | { status: "conflict" }

const isCheck = (block: Block | undefined): block is Extract<Block, { kind: "item" }> =>
  block?.kind === "item" && block.list === "check"

/**
 * What a push may write. `recorded` is what the last push wrote and read back, `current` the remote
 * now, `local` the file now and `lastLocal` the file as the last push read it. Any remote change other
 * than a checklist tick is a conflict, so the push never overwrites someone's edit. A tick follows the
 * side that changed it: the local file when its tick differs from `lastLocal`, the remote otherwise —
 * judged on every push, so a remote tick is not undone once the remote and `recorded` agree again.
 */
export const reconcileBlocks = (
  recorded: Block[],
  current: Block[],
  local: Block[],
  lastLocal: Block[],
): Reconciled => {
  const sameShape =
    recorded.length === current.length &&
    recorded.every((block, index) => blockShape(block) === blockShape(current[index] as Block))
  if (!sameShape) return { status: "conflict" }
  const before = new Map(matches(local, lastLocal, blockShape))
  const blocks = local.map((block) => ({ ...block }))
  let ticksKept = 0
  for (const [i, j] of matches(current, local, blockShape)) {
    const remote = current[i]
    const mine = blocks[j]
    const last = lastLocal[before.get(j) ?? -1]
    if (!isCheck(remote) || !isCheck(mine) || !isCheck(last)) continue
    if (Boolean(mine.checked) === Boolean(last.checked) && Boolean(remote.checked) !== Boolean(mine.checked)) {
      mine.checked = Boolean(remote.checked)
      ticksKept++
    }
  }
  return { status: "clean", blocks, ticksKept }
}
