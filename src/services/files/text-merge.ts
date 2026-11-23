import { posix } from "node:path"
import { markdownBlocks } from "../../documents/markdown-blocks.js"
import type { ConflictPart } from "../../documents/push-model.js"
import { applied, diffSequence, type Hunk, mergeBlocks, touches } from "../documents/block-diff.js"
import { spliceMarkdown } from "../documents/markdown-splice.js"

const MERGEABLE = new Set([".md", ".markdown", ".txt", ".csv", ".tsv"])
/** Above this a text file is merged no more than a binary one: three copies are read whole into memory. */
export const MAX_MERGE_BYTES = 1024 * 1024
const MARKDOWN = new Set([".md", ".markdown"])

/** Whether a file both sides changed is merged line by line rather than reported as a conflict. */
export const mergeable = (path: string, ...sizes: number[]) =>
  MERGEABLE.has(posix.extname(path).toLowerCase()) && sizes.every((size) => size <= MAX_MERGE_BYTES)

/** One stretch of the merge: unchanged, changed on one side, the same change on both, or two different changes. */
export interface TextSegment extends ConflictPart {
  kind: "same" | "local" | "remote" | "both" | "conflict"
  /** The stretch's first line in the base, from 1. */
  line: number
}

export type TextMerge =
  | { merged: Buffer; segments: TextSegment[] }
  | { conflicts: TextSegment[]; segments: TextSegment[] }

/** Lines with their own endings, so `\r\n`, a byte-order mark and a missing last newline come back byte for byte. */
const linesOf = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? []
const same = (line: string) => line

/** A three-way merge of line arrays, diff3 style: stretches both sides changed, unless changed the same, conflict. */
const mergeLines = (base: string[], local: string[], remote: string[]): TextSegment[] => {
  const tagged = [
    ...diffSequence(base, local, same).map((hunk) => ({ ...hunk, side: "local" as const })),
    ...diffSequence(base, remote, same).map((hunk) => ({ ...hunk, side: "remote" as const })),
  ].sort((a, b) => a.from - b.from || a.to - b.to)
  const clusters: (typeof tagged)[] = []
  for (const hunk of tagged) {
    const last = clusters.at(-1)
    if (last?.some((other) => touches(other, hunk))) last.push(hunk)
    else clusters.push([hunk])
  }
  const segments: TextSegment[] = []
  const unchanged = (from: number, to: number) => {
    if (to <= from) return
    const text = base.slice(from, to).join("")
    segments.push({ kind: "same", line: from + 1, base: text, local: text, remote: text })
  }
  let at = 0
  for (const cluster of clusters) {
    const from = cluster.reduce((low, hunk) => Math.min(low, hunk.from), Number.POSITIVE_INFINITY)
    const to = cluster.reduce((high, hunk) => Math.max(high, hunk.to), 0)
    unchanged(at, from)
    at = Math.max(at, to)
    const side = (name: "local" | "remote") =>
      applied<string>(
        base,
        from,
        to,
        cluster.filter((hunk): hunk is Hunk<string> & { side: typeof name } => hunk.side === name),
      ).join("")
    const original = base.slice(from, to).join("")
    const mine = side("local")
    const theirs = side("remote")
    const kind = mine === original ? "remote" : theirs === original ? "local" : mine === theirs ? "both" : "conflict"
    segments.push({ kind, line: from + 1, base: original, local: mine, remote: theirs })
  }
  unchanged(at, base.length)
  return segments
}

const decoded = (text: string) => Buffer.from(text, "latin1").toString("utf8")
/** The merge's bytes, and its segments as UTF-8 text a person reads. */
const resultOf = (lines: TextSegment[]): TextMerge => {
  const segments = lines.map((segment) => ({
    ...segment,
    base: decoded(segment.base),
    local: decoded(segment.local),
    remote: decoded(segment.remote),
  }))
  const conflicts = segments.filter((segment) => segment.kind === "conflict")
  if (conflicts.length) return { conflicts, segments }
  const text = lines.map((segment) => (segment.kind === "remote" ? segment.remote : segment.local)).join("")
  return { merged: Buffer.from(text, "latin1"), segments }
}

const utf8 = (bytes: Buffer) => {
  const text = bytes.toString("utf8")
  return Buffer.from(text, "utf8").equals(bytes) ? text : undefined
}
const BOM = "﻿"
const plain = (text: string) => (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n/g, "\n")

/**
 * Markdown that the line merge could not settle, merged by blocks: a checklist tick and a text edit on the same item
 * no longer collide. Taken only when the remote's text is exactly what its blocks write over the base, so a change the
 * blocks cannot see (front matter, a link definition, `_` for `*`) is never dropped; anything else stays a conflict.
 */
const mergeMarkdown = async (base: Buffer, local: Buffer, remote: Buffer): Promise<Buffer | undefined> => {
  const [baseText, localText, remoteText] = [utf8(base), utf8(local), utf8(remote)]
  if (baseText === undefined || localText === undefined || remoteText === undefined) return undefined
  // The splice writes every line ending as CRLF once the file has one, which would change lines nobody edited.
  if (/\r\n/.test(localText) && /(^|[^\r])\n/.test(localText)) return undefined
  const [baseBlocks, localBlocks, remoteBlocks] = await Promise.all(
    [baseText, localText, remoteText].map((text) => markdownBlocks(plain(text))),
  )
  if (!baseBlocks || !localBlocks || !remoteBlocks) return undefined
  if ((await spliceMarkdown(baseText, remoteBlocks)) !== remoteText) return undefined
  const merged = mergeBlocks(baseBlocks, baseBlocks, localBlocks, remoteBlocks)
  if (merged.status !== "clean") return undefined
  const text = await spliceMarkdown(localText, merged.blocks)
  return text === undefined ? undefined : Buffer.from(text, "utf8")
}

/** Bytes that are no text a line merge can handle: a NUL, or a UTF-16 byte-order mark. */
const binary = (bytes: Buffer) =>
  bytes.includes(0) ||
  (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)))

/**
 * Merges a text file both sides changed since `base`, the content of the last sync. Lines are compared as bytes
 * (read as latin1, which maps each byte to one character), so any 8-bit encoding, line endings and a byte-order mark
 * pass through unchanged. Markdown that conflicts by lines gets a second try by blocks. `segments` always describe the
 * line merge, so a conflict can be shown.
 */
export const mergeText = async (path: string, base: Buffer, local: Buffer, remote: Buffer): Promise<TextMerge> => {
  if ([base, local, remote].some(binary)) {
    const segment: TextSegment = {
      kind: "conflict",
      line: 1,
      base: base.toString("utf8"),
      local: local.toString("utf8"),
      remote: remote.toString("utf8"),
    }
    return { conflicts: [segment], segments: [segment] }
  }
  const lines = (bytes: Buffer) => linesOf(bytes.toString("latin1"))
  const result = resultOf(mergeLines(lines(base), lines(local), lines(remote)))
  if ("merged" in result || !MARKDOWN.has(posix.extname(path).toLowerCase())) return result
  const merged = await mergeMarkdown(base, local, remote)
  return merged ? { merged, segments: result.segments } : result
}

/** The segments' text as one file, with Git's markers around each conflict; `remote` names the other side. */
export const conflictText = (segments: TextSegment[], remote: string) =>
  segments
    .map((segment) => {
      if (segment.kind !== "conflict") return segment.kind === "remote" ? segment.remote : segment.local
      const block = (part: string) => (part && !part.endsWith("\n") ? `${part}\n` : part)
      return (
        `<<<<<<< local\n${block(segment.local)}||||||| base\n${block(segment.base)}=======\n` +
        `${block(segment.remote)}>>>>>>> ${remote}\n`
      )
    })
    .join("")
