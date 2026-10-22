import type { Definition, Nodes, Parent, PhrasingContent, Root, RootContent } from "mdast"
import { type Block, type Inline, type ListKind, normalizeInlines } from "./blocks.js"

// Loaded on first use: importing the documents entry point would otherwise cost every command about 50 ms.
let parser: Promise<(markdown: string) => Root> | undefined
const loadParser = () =>
  (parser ??= Promise.all([
    import("mdast-util-from-markdown"),
    import("mdast-util-gfm"),
    import("micromark-extension-gfm"),
  ]).then(
    ([{ fromMarkdown }, { gfmFromMarkdown }, { gfm }]) =>
      (markdown: string) =>
        fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }),
  ))

type Marks = Omit<Inline, "text">

/**
 * A block and the source it came from: `[start, end)` offsets into the Markdown. Blocks cut from one source
 * stretch (a paragraph and its images, the paragraphs of one quote) share it. `column` is where a list item's
 * text starts, which is how far a nested item under it must be indented.
 */
export interface PlacedBlock {
  block: Block
  start: number
  end: number
  column?: number
}

/** Markdown (CommonMark + GFM tables, task lists and strikethrough) as the blocks a provider can write natively. */
export const markdownBlocks = async (markdown: string): Promise<Block[]> =>
  (await placedMarkdownBlocks(markdown)).map((placed) => placed.block)

export const placedMarkdownBlocks = async (markdown: string): Promise<PlacedBlock[]> => {
  const tree = (await loadParser())(markdown)
  const definitions = new Map<string, Definition>()
  const collect = (node: Nodes) => {
    if (node.type === "definition") definitions.set(node.identifier, node)
    if ("children" in node) for (const child of node.children) collect(child as Nodes)
  }
  collect(tree)

  const images: Block[] = []
  const inlinesOf = (nodes: PhrasingContent[], marks: Marks = {}): Inline[] =>
    nodes.flatMap((node): Inline[] => {
      switch (node.type) {
        case "text":
          return [{ ...marks, text: node.value.replace(/\n/g, " ") }]
        case "inlineCode":
          return [{ ...marks, code: true, text: node.value }]
        case "strong":
          return inlinesOf(node.children, { ...marks, bold: true })
        case "emphasis":
          return inlinesOf(node.children, { ...marks, italic: true })
        case "delete":
          return inlinesOf(node.children, { ...marks, strike: true })
        case "link":
          return inlinesOf(node.children, { ...marks, link: node.url })
        case "linkReference": {
          const url = definitions.get(node.identifier)?.url
          return inlinesOf(node.children, url ? { ...marks, link: url } : marks)
        }
        case "break":
          return [{ ...marks, text: "\n" }]
        case "image":
          images.push({ kind: "image", url: node.url, alt: node.alt ?? "" })
          return []
        case "imageReference": {
          const url = definitions.get(node.identifier)?.url
          if (url) images.push({ kind: "image", url, alt: node.alt ?? "" })
          return []
        }
        case "html":
          return [{ ...marks, text: node.value }]
        default:
          return "children" in node ? inlinesOf(node.children as PhrasingContent[], marks) : []
      }
    })
  const trimmed = (inlines: Inline[]) => {
    const out = normalizeInlines(inlines)
    const first = out[0]
    const last = out.at(-1)
    if (first) first.text = first.text.trimStart()
    if (last) last.text = last.text.trimEnd()
    return normalizeInlines(out)
  }
  const spanOf = (node: Nodes) => ({ start: node.position?.start.offset ?? 0, end: node.position?.end.offset ?? 0 })
  const withImages = (block: Block | undefined, span: { start: number; end: number }): PlacedBlock[] => {
    const found = images.splice(0)
    const blocks = block?.kind === "paragraph" && !block.inlines.length ? found : block ? [block, ...found] : found
    return blocks.map((one) => ({ block: one, ...span }))
  }
  const textOf = (node: Parent): Inline[] =>
    node.children.flatMap((child) =>
      child.type === "paragraph" || child.type === "heading" ? inlinesOf(child.children) : [],
    )

  const blocks = (nodes: RootContent[], depth = 0): PlacedBlock[] =>
    nodes.flatMap((node): PlacedBlock[] => {
      const span = spanOf(node)
      switch (node.type) {
        case "heading":
          return withImages({ kind: "heading", level: node.depth, inlines: trimmed(inlinesOf(node.children)) }, span)
        case "paragraph":
          return withImages({ kind: "paragraph", inlines: trimmed(inlinesOf(node.children)) }, span)
        case "code":
          return [{ block: { kind: "code", ...(node.lang ? { language: node.lang } : {}), text: node.value }, ...span }]
        case "blockquote":
          return node.children
            .flatMap((child) =>
              child.type === "paragraph" || child.type === "heading"
                ? withImages({ kind: "quote", inlines: trimmed(inlinesOf(child.children)) }, span)
                : blocks([child], depth),
            )
            .map((placed) => ({ ...placed, ...span }))
        case "thematicBreak":
          return [{ block: { kind: "rule" }, ...span }]
        case "table": {
          const [head, ...rows] = node.children.map((row) =>
            row.children.map((cell) => trimmed(inlinesOf(cell.children))),
          )
          return [{ block: { kind: "table", header: head ?? [], rows }, ...span }]
        }
        case "list":
          return node.children.flatMap((item) => {
            const [first, ...rest] = item.children
            const head: Block = {
              kind: "item",
              list: (item.checked != null ? "check" : node.ordered ? "number" : "bullet") as ListKind,
              depth,
              ...(item.checked != null ? { checked: item.checked } : {}),
              inlines: trimmed(first && first.type === "paragraph" ? inlinesOf(first.children) : []),
            }
            const tail = first && first.type !== "paragraph" ? [first, ...rest] : rest
            const own = {
              start: spanOf(item).start,
              end: first?.type === "paragraph" ? spanOf(first).end : spanOf(item).start,
            }
            const marker = /^([-+*]|\d{1,9}[.)])( {1,4}|(?=\n)|$)/.exec(markdown.slice(own.start))?.[0].length ?? 2
            const column = (item.position?.start.column ?? 1) - 1 + marker
            return [
              ...withImages(head, own).map((placed) => ({ ...placed, column })),
              ...tail.flatMap((child) =>
                child.type === "list"
                  ? blocks([child], depth + 1)
                  : child.type === "paragraph"
                    ? withImages({ kind: "paragraph", inlines: trimmed(inlinesOf(child.children)) }, spanOf(child))
                    : blocks([child], depth),
              ),
            ]
          })
        case "html":
          return [{ block: { kind: "paragraph", inlines: [{ text: node.value }] }, ...span }]
        case "definition":
        case "footnoteDefinition":
        case "yaml":
          return []
        default:
          return "children" in node
            ? withImages({ kind: "paragraph", inlines: trimmed(textOf(node as Parent)) }, span)
            : []
      }
    })
  return blocks(tree.children)
}
