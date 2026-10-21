export interface Inline {
  text: string
  bold?: true
  italic?: true
  strike?: true
  code?: true
  link?: string
}
export type ListKind = "bullet" | "number" | "check"
export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "item"; list: ListKind; depth: number; checked?: boolean; inlines: Inline[] }
  | { kind: "code"; language?: string; text: string }
  | { kind: "quote"; inlines: Inline[] }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  | { kind: "image"; url: string; alt: string }
  | { kind: "rule" }

const MARKS = ["bold", "italic", "strike", "code", "link"] as const
const sameMarks = (a: Inline, b: Inline) => MARKS.every((mark) => a[mark] === b[mark])

/** Adjacent runs with the same marks merge and empty runs drop, so two equal texts give one key. */
export const normalizeInlines = (inlines: Inline[]): Inline[] => {
  const out: Inline[] = []
  for (const inline of inlines) {
    if (!inline.text) continue
    const last = out.at(-1)
    if (last && sameMarks(last, inline)) last.text += inline.text
    else out.push({ ...inline })
  }
  return out
}

const inlineKey = (inline: Inline) => [inline.text, ...MARKS.map((mark) => inline[mark] ?? "")]
const key = (block: Block, withChecked: boolean): unknown => {
  switch (block.kind) {
    case "heading":
      return [block.kind, block.level, normalizeInlines(block.inlines).map(inlineKey)]
    case "paragraph":
    case "quote":
      return [block.kind, normalizeInlines(block.inlines).map(inlineKey)]
    case "item":
      return [
        block.kind,
        block.list,
        block.depth,
        withChecked && block.list === "check" ? Boolean(block.checked) : "",
        normalizeInlines(block.inlines).map(inlineKey),
      ]
    case "code":
      return [block.kind, block.language ?? "", block.text]
    case "table":
      return [
        block.kind,
        [block.header, ...block.rows].map((row) => row.map((cell) => normalizeInlines(cell).map(inlineKey))),
      ]
    case "image":
      return [block.kind, block.url, block.alt]
    case "rule":
      return [block.kind]
  }
}

export const blockKey = (block: Block): string => JSON.stringify(key(block, true))
/** The same key with checklist ticks left out: two blocks that differ only in a tick share it. */
export const blockShape = (block: Block): string => JSON.stringify(key(block, false))
