import { isCliError } from "@wirecat/cli-base"
import { ReaderLimit } from "../../attachments/container.js"
import { decodeText } from "../../attachments/encoding.js"
import { htmlText } from "../../attachments/markup.js"
import { capped, derived, extensionOf } from "../engine.js"
import type { Extraction, LoadEngine, Reader } from "../types.js"
import { markdownSections, type PageDocument, pageMetadata } from "./page.js"

const HTML = new Set([".html", ".htm", ".xhtml"])

interface Linkedom {
  parseHTML(source: string): { document: PageDocument }
}
interface DefuddleNode {
  Defuddle(
    document: PageDocument,
    url: undefined,
    options: { markdown: true; useAsync: false },
  ): Promise<{ content?: string; title?: string; author?: string; published?: string; site?: string }>
}

const first = (...values: (string | string[] | undefined)[]) =>
  values.find((value): value is string => typeof value === "string" && value !== "")

const loaded = async <T>(load: LoadEngine, name: "linkedom" | "defuddle/node"): Promise<T | undefined> => {
  try {
    return (await load(name)) as T
  } catch {
    return undefined
  }
}

/** Main text as Markdown with the page's own metadata; `undefined` when the engines are absent or find no text. */
const readPage = async (source: string, load: LoadEngine): Promise<Extraction | undefined> => {
  const dom = await loaded<Linkedom>(load, "linkedom")
  const engine = await loaded<DefuddleNode>(load, "defuddle/node")
  if (!dom || !engine) return undefined
  const { document } = dom.parseHTML(source)
  // Before defuddle, which edits the document it is given.
  const metadata = pageMetadata(document)
  const page = await engine.Defuddle(document, undefined, { markdown: true, useAsync: false })
  const text = capped((page.content ?? "").trim())
  if (text === "") return undefined
  const title = first(page.title, metadata["og:title"], metadata.title)
  const merged = {
    ...metadata,
    ...(title ? { title } : {}),
    ...(first(page.author, metadata.author) ? { author: first(page.author, metadata.author) as string } : {}),
    ...(first(page.published, metadata.published)
      ? { published: first(page.published, metadata.published) as string }
      : {}),
    ...(first(metadata.site, page.site) ? { site: first(metadata.site, page.site) as string } : {}),
  }
  return {
    status: "extracted",
    text,
    extractor: "html:v2",
    metadata: merged,
    sections: markdownSections(text),
  }
}

const titleOf = (source: string) =>
  /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source)?.[1]?.replace(/\s+/g, " ").trim() ?? ""

export const html: Reader = {
  id: "html",
  version: "v2",
  accepts: (hint) => HTML.has(extensionOf(hint)) || hint.mime === "text/html" || hint.mime === "application/xhtml+xml",
  read: async (bytes, _hint, context) => {
    const decoded = decodeText(bytes)
    if (!("error" in decoded)) {
      try {
        const page = await readPage(decoded.text, context.load)
        if (page) return page
      } catch (error) {
        if (error instanceof ReaderLimit) return { status: "too-large" }
        if (isCliError(error) && error.code === "cancelled") throw error
      }
    }
    const fallback = derived(bytes, "html:v1", htmlText)
    const title = "error" in decoded ? "" : titleOf(decoded.text)
    return fallback.status === "extracted" && title ? { ...fallback, metadata: { title } } : fallback
  },
}
