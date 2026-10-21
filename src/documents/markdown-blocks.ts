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

/** Markdown (CommonMark + GFM tables, task lists and strikethrough) as the blocks a provider can write natively. */
export const markdownBlocks = async (markdown: string): Promise<Block[]> => {
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
  const withImages = (block: Block | undefined): Block[] => {
    const found = images.splice(0)
    if (block?.kind === "paragraph" && !block.inlines.length) return found
    return block ? [block, ...found] : found
  }
  const textOf = (node: Parent): Inline[] =>
    node.children.flatMap((child) =>
      child.type === "paragraph" || child.type === "heading" ? inlinesOf(child.children) : [],
    )

  const blocks = (nodes: RootContent[], depth = 0): Block[] =>
    nodes.flatMap((node): Block[] => {
      switch (node.type) {
        case "heading":
          return withImages({ kind: "heading", level: node.depth, inlines: trimmed(inlinesOf(node.children)) })
        case "paragraph":
          return withImages({ kind: "paragraph", inlines: trimmed(inlinesOf(node.children)) })
        case "code":
          return [{ kind: "code", ...(node.lang ? { language: node.lang } : {}), text: node.value }]
        case "blockquote":
          return node.children.flatMap((child) =>
            child.type === "paragraph" || child.type === "heading"
              ? withImages({ kind: "quote", inlines: trimmed(inlinesOf(child.children)) })
              : blocks([child], depth),
          )
        case "thematicBreak":
          return [{ kind: "rule" }]
        case "table": {
          const [head, ...rows] = node.children.map((row) =>
            row.children.map((cell) => trimmed(inlinesOf(cell.children))),
          )
          return [{ kind: "table", header: head ?? [], rows }]
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
            return [
              ...withImages(head),
              ...tail.flatMap((child) =>
                child.type === "list"
                  ? blocks([child], depth + 1)
                  : child.type === "paragraph"
                    ? withImages({ kind: "paragraph", inlines: trimmed(inlinesOf(child.children)) })
                    : blocks([child], depth),
              ),
            ]
          })
        case "html":
          return [{ kind: "paragraph", inlines: [{ text: node.value }] }]
        case "definition":
        case "footnoteDefinition":
        case "yaml":
          return []
        default:
          return "children" in node ? withImages({ kind: "paragraph", inlines: trimmed(textOf(node as Parent)) }) : []
      }
    })
  return blocks(tree.children)
}
