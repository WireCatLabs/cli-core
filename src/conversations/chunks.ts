import { createHash } from "node:crypto"
import type { Id } from "../domain/models.js"

/**
 * ~300 tokens: e5's tokenizer reads 3.7 characters a token in Russian and 4.0 in English
 * (phase 5 E1). Characters, not tokens, so a chunk is the same whatever model embeds it.
 */
export const CHUNK_CHARS = 1_200

/** How much of the piece before a split piece repeats at its start, so a sentence cut in two is whole in one. */
export const CHUNK_OVERLAP = 150

export interface ChunkLine {
  id: Id
  sender: string | null
  text: string
}

/** The stretch of one long message a chunk holds, as offsets into its text. */
export interface TextRange {
  start: number
  end: number
}

export interface Chunk {
  firstId: Id
  lastId: Id
  /** Set when the chunk is a piece of one message longer than a chunk: `firstId` and `lastId` are that message. */
  range?: TextRange
  /** What the model is given; never stored, only its hash. */
  text: string
  hash: string
}

const lineOf = ({ sender, text }: ChunkLine) => (sender ? `${sender}: ${text}` : text)

/** A chunk's text from its messages, as the build cut it: what is hashed and what the model reads. */
export const chunkTextOf = (lines: ChunkLine[], range?: TextRange): string =>
  lines
    .map((line) => (range === undefined ? line : { ...line, text: line.text.slice(range.start, range.end) }))
    .filter(({ text }) => text.trim())
    .map(lineOf)
    .join("\n")

const BREAKS = [/\n\s*\n/g, /\n/g, /[.!?…](?=\s)/g, /\s/g]

/** The last place at or before `end`, and after the first half of the piece, where `text` breaks most naturally. */
const breakBefore = (text: string, start: number, end: number): number => {
  const floor = start + Math.floor((end - start) / 2)
  for (const pattern of BREAKS) {
    let found = -1
    for (const match of text.slice(floor, end).matchAll(pattern)) found = floor + match.index + match[0].length
    if (found > floor) return found
  }
  return end
}

/**
 * One text longer than `room` as overlapping pieces of at most `room` characters, cut at a paragraph,
 * then a line, a sentence or a word where it can. Each piece after the first starts `overlap` before the
 * last one ended, at a word.
 */
export const splitText = (text: string, room: number, overlap = CHUNK_OVERLAP, check?: () => void): TextRange[] => {
  const ranges: TextRange[] = []
  for (let start = 0; start < text.length; ) {
    check?.()
    const end = start + room >= text.length ? text.length : breakBefore(text, start, start + room)
    ranges.push({ start, end })
    if (end >= text.length) break
    const back = Math.max(start + 1, end - overlap)
    const word = text.slice(back, end).search(/\s\S/)
    start = word === -1 ? back : back + word + 1
  }
  return ranges
}

export const chunkHash = (text: string): string => createHash("sha256").update(text).digest("hex")

/**
 * A conversation, oldest message first, cut at message boundaries into chunks of at most `limit`
 * characters. A message longer than the limit is split into overlapping pieces, a chunk each, so the
 * model reads all of a long note or mail rather than its beginning. Messages with no text add nothing,
 * and a conversation of only those has no chunk.
 *
 * With `carry`, each chunk after the first opens with up to that many characters from the end of the
 * message before it, so a reply is read with what it answers; such a chunk may run `carry` over `limit`.
 * A chunk depends only on the messages before it, so a new message never changes a chunk already closed.
 */
export const cutChunks = (members: ChunkLine[], limit = CHUNK_CHARS, check?: () => void, carry = 0): Chunk[] => {
  const chunks: Chunk[] = []
  let open: ChunkLine[] = []
  let size = 0
  let seeded = false
  const seed = (member: ChunkLine) => {
    if (carry === 0) return
    const from = Math.max(0, member.text.length - carry)
    const word = from === 0 ? 0 : member.text.slice(from).search(/\s\S/) + 1
    const text = member.text.slice(from + Math.max(0, word)).trim()
    if (!text) return
    open = [{ ...member, text }]
    size = lineOf(open[0] as ChunkLine).length
    seeded = true
  }
  const close = () => {
    const first = open[0]
    const last = open.at(-1)
    if (!first || !last || (seeded && open.length === 1)) return
    const text = chunkTextOf(open)
    chunks.push({ firstId: first.id, lastId: last.id, text, hash: chunkHash(text) })
    open = []
    size = 0
    seeded = false
    seed(last)
  }
  for (const member of members) {
    check?.()
    if (!member.text.trim()) continue
    const length = lineOf(member).length
    if (length > limit) {
      close()
      open = []
      size = 0
      seeded = false
      const room = Math.max(Math.floor(limit / 2), limit - (lineOf(member).length - member.text.length))
      for (const range of splitText(member.text, room, CHUNK_OVERLAP, check)) {
        const text = chunkTextOf([member], range)
        if (text) chunks.push({ firstId: member.id, lastId: member.id, range, text, hash: chunkHash(text) })
      }
      seed(member)
      continue
    }
    if (open.length > 0 && !(seeded && open.length === 1) && size + 1 + length > limit) close()
    size += (open.length > 0 ? 1 : 0) + length
    open.push(member)
  }
  close()
  return chunks
}
