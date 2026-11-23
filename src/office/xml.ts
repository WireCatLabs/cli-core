import { CliError } from "@wirecat/cli-base"

/** An element with its offsets in the part's text, so an edit replaces a span and leaves every other byte alone. */
export interface XmlElement {
  readonly name: string
  readonly prefix: string
  readonly local: string
  readonly ns: string
  readonly attributes: ReadonlyMap<string, string>
  readonly start: number
  readonly openEnd: number
  closeStart: number
  end: number
  readonly children: XmlElement[]
  readonly parent: XmlElement | undefined
  readonly namespaces: ReadonlyMap<string, string>
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }
const ATTRIBUTE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

const invalid = (reason: string) => new CliError("validation_error", `the file's XML cannot be edited: ${reason}`)

export const decodeEntities = (raw: string) =>
  raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)))
    const value = ENTITIES[entity]
    if (value === undefined) throw invalid(`unknown entity ${whole}`)
    return value
  })

/** Element content as text: entities decoded, CDATA unwrapped, comments and processing instructions dropped. */
export const contentText = (raw: string) =>
  raw
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>)/)
    .map((part) =>
      part.startsWith("<![CDATA[")
        ? part.slice(9, -3)
        : part.startsWith("<!--") || part.startsWith("<?")
          ? ""
          : decodeEntities(part),
    )
    .join("")

// XML 1.0 allows tab, newline, carriage return and everything from U+0020 except lone surrogates and U+FFFE/U+FFFF.
const storable = (value: string) => {
  for (const character of value) {
    const code = character.codePointAt(0) as number
    if (
      code < 0x20
        ? ![9, 10, 13].includes(code)
        : (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff
    )
      return false
  }
  return true
}

export const escapeText = (value: string) => {
  if (!storable(value))
    throw new CliError("validation_error", "the text holds a character XML cannot store (a control character)")
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

export const parseXml = (text: string): XmlElement => {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw invalid("a DOCTYPE")
  const root: XmlElement[] = []
  const stack: XmlElement[] = []
  for (let index = text.indexOf("<"); index >= 0 && index < text.length; index = text.indexOf("<", index)) {
    const skip = text.startsWith("<!--", index)
      ? "-->"
      : text.startsWith("<![CDATA[", index)
        ? "]]>"
        : text.startsWith("<?", index)
          ? "?>"
          : undefined
    if (skip) {
      const end = text.indexOf(skip, index)
      if (end < 0) throw invalid("an unclosed comment or CDATA")
      index = end + skip.length
      continue
    }
    const start = index
    let quote = ""
    for (index++; index < text.length; index++) {
      const char = text[index]
      if (quote) {
        if (char === quote) quote = ""
      } else if (char === '"' || char === "'") quote = char
      else if (char === ">") break
    }
    if (index >= text.length) throw invalid("an unclosed tag")
    index++
    const tag = text.slice(start, index)
    if (tag.startsWith("</")) {
      const name = tag.slice(2, -1).trim()
      const open = stack.pop()
      if (!open || open.name !== name) throw invalid(`a closing </${name}> without its opening tag`)
      open.closeStart = start
      open.end = index
      continue
    }
    const selfClosing = /\/\s*>$/.test(tag)
    const body = tag.slice(1, selfClosing ? tag.lastIndexOf("/") : -1)
    const name = /^[^\s/>]+/.exec(body)?.[0]
    if (!name) throw invalid("a tag without a name")
    const attributes = new Map<string, string>()
    for (const match of body.slice(name.length).matchAll(ATTRIBUTE))
      attributes.set(match[1] as string, decodeEntities(match[2] ?? match[3] ?? ""))
    const parent = stack.at(-1)
    const namespaces = new Map(parent?.namespaces ?? [["xml", "http://www.w3.org/XML/1998/namespace"]])
    for (const [key, value] of attributes) {
      if (key === "xmlns") namespaces.set("", value)
      else if (key.startsWith("xmlns:")) namespaces.set(key.slice(6), value)
    }
    const colon = name.indexOf(":")
    const prefix = colon < 0 ? "" : name.slice(0, colon)
    const ns = namespaces.get(prefix)
    if (ns === undefined && prefix) throw invalid(`an undeclared prefix ${prefix}:`)
    const element: XmlElement = {
      name,
      prefix,
      local: colon < 0 ? name : name.slice(colon + 1),
      ns: ns ?? "",
      attributes,
      start,
      openEnd: index,
      closeStart: index,
      end: index,
      children: [],
      parent,
      namespaces,
    }
    ;(parent ? parent.children : root).push(element)
    if (!selfClosing) stack.push(element)
  }
  if (stack.length || root.length !== 1) throw invalid("unbalanced elements")
  return root[0] as XmlElement
}

/** An attribute by its namespace and local name, whatever prefix the file uses for it. */
export const attributeOf = (element: XmlElement, ns: string, local: string) => {
  for (const [key, value] of element.attributes) {
    const colon = key.indexOf(":")
    if (colon < 0) {
      if (!ns && key === local) return value
      continue
    }
    if (key.slice(colon + 1) === local && element.namespaces.get(key.slice(0, colon)) === ns) return value
  }
  return undefined
}

export const childrenOf = (element: XmlElement, ns: string, local: string) =>
  element.children.filter((child) => child.ns === ns && child.local === local)

export const descendants = (element: XmlElement, ns: string, local: string): XmlElement[] => {
  const found: XmlElement[] = []
  const visit = (current: XmlElement) => {
    for (const child of current.children) {
      if (child.ns === ns && child.local === local) found.push(child)
      visit(child)
    }
  }
  visit(element)
  return found
}

export interface Splice {
  readonly start: number
  readonly end: number
  readonly text: string
}

/** Applies non-overlapping replacements; an insert goes before a replacement at its offset, inserts keep their order. */
export const applySplices = (text: string, splices: readonly Splice[]) => {
  const ordered = splices
    .map((splice, order) => ({ ...splice, order }))
    .sort((a, b) => a.start - b.start || Number(a.end > a.start) - Number(b.end > b.start) || a.order - b.order)
  let result = ""
  let at = 0
  for (const splice of ordered) {
    if (splice.start < at) throw new Error("overlapping_edits")
    result += text.slice(at, splice.start) + splice.text
    at = splice.end
  }
  return result + text.slice(at)
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

/** A part's text; only UTF-8 parts are edited, since a rewrite in another encoding would contradict its declaration. */
export const partText = (bytes: Uint8Array, path: string) => {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 100))
  const declared = /^(?:﻿|ï»¿)?<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/.exec(head)?.[1]
  if (declared && !/^utf-?8$/i.test(declared))
    throw new CliError("validation_error", `${path} is stored as ${declared}; only UTF-8 parts can be edited`)
  try {
    return decoder.decode(bytes)
  } catch {
    throw new CliError("validation_error", `${path} is not UTF-8; only UTF-8 parts can be edited`)
  }
}

export const partBytes = (text: string) => encoder.encode(text)
