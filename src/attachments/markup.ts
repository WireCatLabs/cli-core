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

const HTML_DROPPED = /<(script|style|head|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const HTML_BLOCK = /<\/?(p|div|br|li|ul|ol|tr|h[1-6]|blockquote|pre|section|article|header|footer|table|hr)\b[^>]*>/gi
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }

/** The visible text of an HTML page: no scripts, styles or tags, blocks on their own lines, entities decoded. */
export const htmlText = (source: string): string =>
  source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(HTML_DROPPED, "")
    .replace(/<\/t[dh]\s*>/gi, "\t")
    .replace(HTML_BLOCK, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (entity, body: string) => {
      const lower = body.toLowerCase()
      if (lower.startsWith("#x")) return safeChar(Number.parseInt(lower.slice(2), 16), entity)
      if (lower.startsWith("#")) return safeChar(Number(lower.slice(1)), entity)
      return ENTITIES[lower] ?? entity
    })
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

const safeChar = (code: number, fallback: string) =>
  code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback
