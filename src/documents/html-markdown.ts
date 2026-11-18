import type { Nodes, Parent, Root } from "mdast"

// Loaded on first use, as markdown-blocks.ts loads its parser: most commands never convert a body.
let converters: ReturnType<typeof importAll> | undefined
const loaded = () => (converters ??= importAll())
const importAll = async () => {
  const [fromHtml, toMdast, toMarkdown, fromMarkdown, gfmMdast, gfmMicromark, toHast, toHtml] = await Promise.all([
    import("hast-util-from-html"),
    import("hast-util-to-mdast"),
    import("mdast-util-to-markdown"),
    import("mdast-util-from-markdown"),
    import("mdast-util-gfm"),
    import("micromark-extension-gfm"),
    import("mdast-util-to-hast"),
    import("hast-util-to-html"),
  ])
  return {
    fromHtml: fromHtml.fromHtml,
    toMdast: toMdast.toMdast,
    toMarkdown: toMarkdown.toMarkdown,
    fromMarkdown: fromMarkdown.fromMarkdown,
    gfmToMarkdown: gfmMdast.gfmToMarkdown,
    gfmFromMarkdown: gfmMdast.gfmFromMarkdown,
    gfm: gfmMicromark.gfm,
    toHast: toHast.toHast,
    toHtml: toHtml.toHtml,
  }
}

// A post body is untrusted: a link or image that runs code or reads a file must not survive into what a CLI shows
// or writes back. A URL with no scheme (relative, `#anchor`) stays.
const SAFE_URL = /^(?:https?:|mailto:|tel:|[^:]*$|[^:]*[/?#])/i
const unsafe = (url: string) => !SAFE_URL.test(url.trim())

// The first definition of a label wins in CommonMark: dropping only an unsafe first one would hand its references to
// a later definition the author never meant.
const unsafeLabels = (node: Nodes, first = new Map<string, boolean>()): Map<string, boolean> => {
  if (node.type === "definition" && !first.has(node.identifier)) first.set(node.identifier, unsafe(node.url))
  if ("children" in node) for (const child of node.children) unsafeLabels(child, first)
  return first
}

const safeChildren = (node: Parent, labels: Map<string, boolean>): void => {
  node.children = (node.children as Nodes[]).flatMap((child): Nodes[] => {
    // Raw HTML, including the comments WordPress and Ghost wrap their blocks and cards in.
    if (child.type === "html") return []
    if (child.type === "definition" && (unsafe(child.url) || labels.get(child.identifier))) return []
    if (child.type === "link" && unsafe(child.url)) {
      safeChildren(child, labels)
      return child.children
    }
    if (child.type === "image" && unsafe(child.url)) return child.alt ? [{ type: "text", value: child.alt }] : []
    if ("children" in child) safeChildren(child, labels)
    return [child]
  }) as typeof node.children
}

const makeSafe = (tree: Root): Root => {
  safeChildren(tree, unsafeLabels(tree))
  return tree
}

/**
 * HTML as Markdown (CommonMark + GFM tables): a WordPress post's `content.rendered` or its raw `content` with block
 * comments, a Ghost post's `html`. Comments, scripts, styles, frames and event attributes are dropped, and so are links
 * and images with a scheme other than http(s), mailto and tel.
 */
export const htmlToMarkdown = async (html: string): Promise<string> => {
  const { fromHtml, toMdast, toMarkdown, gfmToMarkdown } = await loaded()
  const tree = makeSafe(toMdast(fromHtml(html, { fragment: true })) as Root)
  return toMarkdown(tree, { extensions: [gfmToMarkdown()] })
}

/**
 * Markdown (CommonMark + GFM) as HTML for a service that stores HTML, such as WordPress or Ghost. Raw HTML in the
 * Markdown is not passed through, and links and images with an unsafe scheme are dropped, as `htmlToMarkdown` does.
 */
export const markdownToHtml = async (markdown: string): Promise<string> => {
  const { fromMarkdown, gfmFromMarkdown, gfm, toHast, toHtml } = await loaded()
  const tree = makeSafe(fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }))
  return toHtml(toHast(tree))
}
