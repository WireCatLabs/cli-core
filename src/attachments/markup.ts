import iconv from "iconv-lite"
import { ReaderLimit } from "./container.js"
import { MAX_TEXT_CHARS } from "./limits.js"

/** Groups whose text is not the document's: fonts, styles, metadata, pictures, field codes. */
const RTF_SKIPPED = new Set([
  "fonttbl",
  "colortbl",
  "stylesheet",
  "info",
  "pict",
  "object",
  "header",
  "headerl",
  "headerr",
  "headerf",
  "footer",
  "footerl",
  "footerr",
  "footerf",
  "listtable",
  "listoverridetable",
  "rsidtbl",
  "generator",
  "xmlnstbl",
  "themedata",
  "colorschememapping",
  "datastore",
  "latentstyles",
  "filetbl",
  "revtbl",
  "fldinst",
  "pgdsctbl",
])
const RTF_SPECIAL: Record<string, string> = {
  par: "\n",
  sect: "\n",
  page: "\n",
  line: "\n",
  row: "\n",
  tab: "\t",
  cell: "\t",
  emdash: "—",
  endash: "–",
  emspace: " ",
  enspace: " ",
  bullet: "•",
  lquote: "‘",
  rquote: "’",
  ldblquote: "“",
  rdblquote: "”",
}
const RTF_TOKEN = /\\([a-z]{1,32})(-?\d{1,10})? ?|\\'([0-9a-f]{2})|\\([^a-z])|([{}])|[\r\n]+|([^\\{}\r\n]+)/gi

/** The text of an RTF document: groups that hold no text are skipped, `\'hh` read in its code page. */
export const rtfText = (source: string): string => {
  let codepage = "windows-1252"
  let skip = 0
  let ignorable = false
  let unicodeSkip = 1
  const stack: { ignorable: boolean; unicodeSkip: number }[] = []
  const out: string[] = []
  let length = 0
  let bytes: number[] = []
  const flush = () => {
    if (!bytes.length) return
    push(iconv.decode(Buffer.from(bytes), codepage))
    bytes = []
  }
  const push = (text: string) => {
    length += text.length
    if (length > MAX_TEXT_CHARS) throw new ReaderLimit()
    out.push(text)
  }
  for (const [, word, argument, hex, symbol, brace, text] of source.matchAll(RTF_TOKEN)) {
    if (brace === "{") {
      flush()
      skip = 0
      stack.push({ ignorable, unicodeSkip })
    } else if (brace === "}") {
      flush()
      skip = 0
      ;({ ignorable, unicodeSkip } = stack.pop() ?? { ignorable, unicodeSkip })
    } else if (symbol !== undefined) {
      flush()
      skip = 0
      if (symbol === "*") ignorable = true
      else if (!ignorable && symbol === "~") push(" ")
      else if (!ignorable && symbol === "_") push("‑")
      else if (!ignorable && "\\{}".includes(symbol)) push(symbol)
    } else if (word !== undefined) {
      flush()
      skip = 0
      const name = word.toLowerCase()
      if (name === "ansicpg" && argument) codepage = iconv.encodingExists(`cp${argument}`) ? `cp${argument}` : codepage
      else if (name === "uc" && argument) unicodeSkip = Number(argument)
      else if (RTF_SKIPPED.has(name)) ignorable = true
      else if (ignorable) continue
      else if (RTF_SPECIAL[name]) push(RTF_SPECIAL[name])
      else if (name === "u" && argument) {
        const code = Number(argument)
        push(String.fromCharCode(code < 0 ? code + 0x10000 : code))
        skip = unicodeSkip
      }
    } else if (hex !== undefined) {
      if (skip > 0) skip -= 1
      else if (!ignorable) bytes.push(Number.parseInt(hex, 16))
    } else if (text !== undefined) {
      flush()
      if (ignorable) continue
      const kept = skip >= text.length ? "" : text.slice(skip)
      skip = Math.max(0, skip - text.length)
      if (kept) push(kept)
    }
  }
  flush()
  return out.join("").trim()
}

const HTML_DROPPED_OPEN = /<(script|style|head|noscript|template|svg)\b/gi
const HTML_DROPPED_CLOSE = new Map(
  ["script", "style", "head", "noscript", "template", "svg"].map((name) => [
    name,
    new RegExp(`<\\/${name}\\s*>`, "gi"),
  ]),
)
const HTML_BLOCK = /<\/?(p|div|br|li|ul|ol|tr|h[1-6]|blockquote|pre|section|article|header|footer|table|hr)\b[^>]*>/gi
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" }

// Past the last `>` no tag can close, yet `[^>]*` would rescan to the end from every `<` there: quadratic on `<<<<…`.
const replaceTags = (source: string, tag: RegExp, replacement: string): string => {
  const end = source.lastIndexOf(">") + 1
  return source.slice(0, end).replace(tag, replacement) + source.slice(end)
}

// `<script>[\s\S]*?</script>` as one regex rescans to the end from every unclosed opener; a tag found
// unclosed once stays unclosed for every later opener, so each close is searched for at most once.
const dropHidden = (source: string): string => {
  const unclosed = new Set<string>()
  let out = ""
  let kept = 0
  for (const open of source.matchAll(HTML_DROPPED_OPEN)) {
    const name = (open[1] as string).toLowerCase()
    if (open.index < kept || unclosed.has(name)) continue
    const gt = source.indexOf(">", open.index + open[0].length)
    if (gt < 0) break
    const close = HTML_DROPPED_CLOSE.get(name) as RegExp
    close.lastIndex = gt + 1
    const end = close.exec(source)
    if (!end) {
      unclosed.add(name)
      continue
    }
    out += source.slice(kept, open.index)
    kept = end.index + end[0].length
  }
  return out + source.slice(kept)
}

/** The visible text of an HTML page: no scripts, styles or tags, blocks on their own lines, entities decoded. */
export const htmlText = (source: string): string => {
  // An unclosed comment eats the rest unchanged, as the plain `<!--[\s\S]*?-->` left it, without a rescan per `<!--`.
  const uncommented = source.replace(/<!--[\s\S]*?(-->|$)/g, (comment, close: string) => (close ? "" : comment))
  const blocks = replaceTags(dropHidden(uncommented).replace(/<\/t[dh]\s*>/gi, "\t"), HTML_BLOCK, "\n")
  return (
    replaceTags(blocks, /<[^>]*>/g, "")
      .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (entity, body: string) => {
        const lower = body.toLowerCase()
        if (lower.startsWith("#x")) return safeChar(Number.parseInt(lower.slice(2), 16), entity)
        if (lower.startsWith("#")) return safeChar(Number(lower.slice(1)), entity)
        return ENTITIES[lower] ?? entity
      })
      // From the start of a run only: `[ \t]+\n` alone rescans a long run of spaces from each of them.
      .replace(/(?<![ \t\u00a0])[ \t\u00a0]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  )
}

const safeChar = (code: number, fallback: string) =>
  code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback
