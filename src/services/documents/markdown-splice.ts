import { type Block, blockKey, blockShape, type Inline, normalizeInlines } from "../../documents/blocks.js"
import { markdownBlocks, type PlacedBlock, placedMarkdownBlocks } from "../../documents/markdown-blocks.js"
import { type BlockHunk, diffBlocks } from "./block-diff.js"

const escapeText = (text: string) => text.replace(/[\\`*_[\]<>~|]/g, "\\$&")
const codeSpan = (text: string) => {
  const longest = (text.match(/`+/g) ?? []).reduce((most, run) => Math.max(most, run.length), 0)
  const fence = "`".repeat(longest + 1)
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : ""
  return `${fence}${pad}${text}${pad}${fence}`
}
const linkTarget = (url: string) => (/[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, encodeURIComponent)}>` : url)
const styled = (inline: Inline) => {
  const text = inline.code ? codeSpan(inline.text) : escapeText(inline.text)
  // A delimiter next to a space does not open or close emphasis, so spaces stay outside the marks.
  const [, lead = "", core = "", trail = ""] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) ?? []
  if (!core) return text
  let marked = core
  if (inline.strike) marked = `~~${marked}~~`
  if (inline.italic) marked = `*${marked}*`
  if (inline.bold) marked = `**${marked}**`
  return `${lead}${marked}${trail}`
}

/** Inline runs as Markdown; a run of one link is written as one link. `indent` continues a line after a hard break. */
export const inlineMarkdown = (inlines: Inline[], indent = ""): string => {
  const runs = normalizeInlines(inlines)
  let out = ""
  for (let at = 0; at < runs.length; ) {
    const link = runs[at]?.link
    let body = ""
    for (; at < runs.length && runs[at]?.link === link; at++)
      body += styled({ ...(runs[at] as Inline), link: undefined })
    out += link ? `[${body}](${linkTarget(link)})` : body
  }
  return out
    .replace(/^(#{1,6}\s|[-+*>]\s|[=-]+\s*$)/, "\\$1")
    .replace(/^(\d{1,9})([.)]\s)/, "$1\\$2")
    .replaceAll("\n", `\\\n${indent}`)
}

const MARKERS = { bullet: "- ", number: "1. ", check: "- " } as const

/**
 * Blocks as Markdown, one after another. `columns` holds, per depth, where the text of the list item before
 * the first block starts, so a nested item lines up under a parent written elsewhere in the file.
 */
export const blocksMarkdown = (blocks: Block[], columns: number[] = []): string => {
  const lines: string[] = []
  const depths = [...columns]
  let previous: Block | undefined
  for (const block of blocks) {
    if (previous) lines.push(previous.kind === "item" && block.kind === "item" ? "\n" : "\n\n")
    previous = block
    switch (block.kind) {
      case "heading":
        lines.push(`${"#".repeat(block.level)} ${inlineMarkdown(block.inlines)}`)
        break
      case "paragraph":
        lines.push(inlineMarkdown(block.inlines))
        break
      case "quote":
        lines.push(`> ${inlineMarkdown(block.inlines, "> ")}`)
        break
      case "code": {
        const longest = (block.text.match(/^`+/gm) ?? []).reduce((most, run) => Math.max(most, run.length), 2)
        const fence = "`".repeat(longest + 1)
        lines.push(`${fence}${block.language ?? ""}\n${block.text}\n${fence}`)
        break
      }
      case "rule":
        lines.push("---")
        break
      case "image":
        lines.push(`![${escapeText(block.alt)}](${linkTarget(block.url)})`)
        break
      case "table": {
        const width = block.rows.reduce((most, row) => Math.max(most, row.length), Math.max(block.header.length, 1))
        const row = (cells: Inline[][]) =>
          `| ${Array.from({ length: width }, (_, index) => inlineMarkdown(cells[index] ?? []).replaceAll("\\\n", " ") || " ").join(" | ")} |`
        lines.push([row(block.header), `|${" --- |".repeat(width)}`, ...block.rows.map(row)].join("\n"))
        break
      }
      case "item": {
        const indent = block.depth === 0 ? 0 : (depths[block.depth - 1] ?? block.depth * 2)
        const marker = MARKERS[block.list]
        const box = block.list === "check" ? (block.checked ? "[x] " : "[ ] ") : ""
        const column = indent + marker.length
        depths.length = block.depth
        depths[block.depth] = column
        lines.push(`${" ".repeat(indent)}${marker}${box}${inlineMarkdown(block.inlines, " ".repeat(column))}`)
        break
      }
    }
  }
  return lines.join("")
}

const BLANK_BETWEEN = (a: Block | undefined, b: Block | undefined) =>
  Boolean(a && b) && !(a?.kind === "item" && b?.kind === "item")

/**
 * The Markdown file `text` changed so that it reads as `next`, touching only the lines of blocks that differ:
 * everything else stays byte for byte, line endings and a byte-order mark included. `normalize` maps the file's
 * blocks one to one onto the form `next` is in. Undefined when the result would not read back as `next`, which
 * a caller reports instead of writing.
 */
export const spliceMarkdown = async (
  text: string,
  next: Block[],
  normalize: (blocks: Block[]) => Block[] = (blocks) => blocks,
): Promise<string | undefined> => {
  const bom = text.startsWith("﻿") ? "﻿" : ""
  const crlf = text.includes("\r\n")
  let body = (bom ? text.slice(1) : text).replace(/\r\n/g, "\n")
  const placed = await placedMarkdownBlocks(body)
  const current = normalize(placed.map((item) => item.block))
  if (current.length !== placed.length) return undefined
  const hunks = grouped(diffBlocks(current, next), placed, current)
  if (!hunks.length) return text

  const lineStart = (offset: number) => body.lastIndexOf("\n", offset - 1) + 1
  for (const hunk of [...hunks].reverse()) {
    const toggled = tick(body, hunk, placed, current)
    if (toggled !== undefined) {
      body = toggled
      continue
    }
    if (body && !body.endsWith("\n")) body += "\n"
    const cutStart = hunk.from < placed.length ? lineStart((placed[hunk.from] as PlacedBlock).start) : body.length
    const cutEnd = hunk.to < placed.length ? lineStart((placed[hunk.to] as PlacedBlock).start) : body.length
    const before = current[hunk.from - 1]
    const after = current[hunk.to]
    let head = body.slice(0, cutStart)
    const first = hunk.blocks[0] ?? after
    if (BLANK_BETWEEN(before, first) && head && !head.endsWith("\n\n")) head += "\n"
    let insert = ""
    if (hunk.blocks.length) {
      insert = `${blocksMarkdown(hunk.blocks, columnsBefore(placed, hunk.from))}\n`
      if (BLANK_BETWEEN(hunk.blocks.at(-1), after)) insert += "\n"
    }
    body = head + insert + body.slice(cutEnd)
  }
  const reread = normalize(await markdownBlocks(body))
  if (
    reread.length !== next.length ||
    reread.some((block, index) => blockKey(block) !== blockKey(next[index] as Block))
  )
    return undefined
  return bom + (crlf ? body.replace(/\n/g, "\r\n") : body)
}

/** A hunk that cuts through blocks sharing one source stretch grows to take all of them. */
const grouped = (hunks: BlockHunk[], placed: PlacedBlock[], current: Block[]): BlockHunk[] => {
  const shares = (index: number) =>
    index > 0 && index < placed.length && placed[index]?.start === placed[index - 1]?.start
  const out: BlockHunk[] = []
  for (const hunk of hunks) {
    let { from, to } = hunk
    while (shares(from)) from--
    while (shares(to)) to++
    const blocks = [...current.slice(from, hunk.from), ...hunk.blocks, ...current.slice(hunk.to, to)]
    const last = out.at(-1)
    if (last && from <= last.to) {
      last.blocks = [...last.blocks, ...current.slice(last.to, from), ...blocks.slice(Math.max(0, last.to - from))]
      last.to = Math.max(last.to, to)
    } else out.push({ from, to, blocks })
  }
  return out
}

/** Checklist items whose only change is their tick get their boxes flipped in place. */
const tick = (body: string, hunk: BlockHunk, placed: PlacedBlock[], current: Block[]): string | undefined => {
  if (hunk.to - hunk.from !== hunk.blocks.length) return undefined
  let out = body
  for (let offset = hunk.blocks.length - 1; offset >= 0; offset--) {
    const before = current[hunk.from + offset]
    const after = hunk.blocks[offset]
    if (before?.kind !== "item" || after?.kind !== "item" || blockShape(before) !== blockShape(after)) return undefined
    const { start, end } = placed[hunk.from + offset] as PlacedBlock
    const line = out.slice(start, end)
    const box = /^(\S+\s+)\[[ xX]\]/.exec(line)
    if (!box) return undefined
    out = `${out.slice(0, start)}${box[1]}[${after.checked ? "x" : " "}]${line.slice(box[0].length)}${out.slice(end)}`
  }
  return out
}

/** Where the text of the nearest list item at each depth before `index` starts. */
const columnsBefore = (placed: PlacedBlock[], index: number): number[] => {
  const columns: number[] = []
  let lowest = Number.POSITIVE_INFINITY
  for (let at = index - 1; at >= 0 && lowest > 0; at--) {
    const item = placed[at] as PlacedBlock
    if (item.block.kind !== "item") break
    if (item.block.depth < lowest) {
      lowest = item.block.depth
      columns[lowest] = item.column ?? 2 * (lowest + 1)
    }
  }
  return columns
}
