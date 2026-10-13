import type { Section } from "../types.js"

export type PageMetadata = Record<string, string | string[]>

interface Attributes {
  getAttribute(name: string): string | null
}

export interface PageDocument {
  title?: string
  documentElement: Attributes
  querySelector(selector: string): (Attributes & { textContent: string | null }) | null
  querySelectorAll(selector: string): Iterable<Attributes & { textContent: string | null }>
}

const clean = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "")

const namesIn = (value: unknown): string =>
  [value]
    .flat()
    .map((entry) => (typeof entry === "string" ? clean(entry) : clean((entry as { name?: unknown } | null)?.name)))
    .filter(Boolean)
    .join(", ")

const jsonLdNodes = (document: PageDocument): Record<string, unknown>[] => {
  const nodes: Record<string, unknown>[] = []
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const json = JSON.parse(script.textContent ?? "") as Record<string, unknown>
      nodes.push(...([json["@graph"] ?? json].flat() as Record<string, unknown>[]))
    } catch {}
  }
  return nodes.filter((node) => typeof node === "object" && node !== null)
}

/** What the page says about itself in its head: meta tags, Open Graph, JSON-LD and the language of `<html>`. */
export const pageMetadata = (document: PageDocument): PageMetadata => {
  const meta = (selector: string) => clean(document.querySelector(selector)?.getAttribute("content"))
  const nodes = jsonLdNodes(document)
  const primary =
    nodes.find((node) => /Article|Posting|Product|WebPage/.test([node["@type"]].flat().join(" "))) ?? nodes[0]
  const out: PageMetadata = {}
  const set = (key: string, value: string | string[] | undefined) => {
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return
    out[key] = value
  }
  set("title", clean(document.title))
  set("description", meta('meta[name="description"]') || meta('meta[property="og:description"]'))
  set("author", meta('meta[name="author"]') || meta('meta[property="article:author"]') || namesIn(primary?.author))
  set("published", meta('meta[property="article:published_time"]') || clean(primary?.datePublished))
  set("language", clean(document.documentElement.getAttribute("lang")))
  set("site", meta('meta[property="og:site_name"]'))
  set("canonical", clean(document.querySelector('link[rel="canonical"]')?.getAttribute("href")))
  set("keywords", meta('meta[name="keywords"]').split(",").map(clean).filter(Boolean))
  for (const tag of document.querySelectorAll('meta[property^="og:"]')) {
    const key = clean(tag.getAttribute("property"))
    if (!(key in out)) set(key, clean(tag.getAttribute("content")))
  }
  set(
    "jsonLdType",
    nodes.flatMap((node) => [node["@type"]].flat().filter((kind) => typeof kind === "string")) as string[],
  )
  return out
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/

/** One section per Markdown heading, from its line to the next heading; fenced code is not scanned. */
export const markdownSections = (text: string): Section[] => {
  const found: Section[] = []
  let fence = false
  let at = 0
  for (const line of text.split("\n")) {
    if (/^(```|~~~)/.test(line)) fence = !fence
    const match = fence ? null : HEADING.exec(line)
    if (match?.[1] && match[2]) found.push({ heading: match[2], level: match[1].length, start: at, end: text.length })
    at += line.length + 1
  }
  return found.map((section, index) => ({ ...section, end: found[index + 1]?.start ?? text.length }))
}
