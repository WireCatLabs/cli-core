import { posix } from "node:path"
import { CliError } from "@wirecat/cli-base"
import type { Element, Node } from "@xmldom/xmldom"
import { elements, ReaderLimit, readContainer, xmlPart } from "./container.js"
import type { Extraction, FileHint } from "./extract.js"

import { MAX_TEXT_CHARS as MAX_TEXT } from "./limits.js"

const OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0"
const TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"
const TABLE = "urn:oasis:names:tc:opendocument:xmlns:table:1.0"
const ODF_DRAW = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
const PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const STRICT_REL = "http://purl.oclc.org/ooxml/officeDocument/relationships"
const SHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
const SLIDE = "http://schemas.openxmlformats.org/presentationml/2006/main"
const DRAW = "http://schemas.openxmlformats.org/drawingml/2006/main"
const OPF = "http://www.idpf.org/2007/opf"
const XHTML = "http://www.w3.org/1999/xhtml"
export type DocumentKind = "odt" | "ods" | "odp" | "xlsx" | "pptx" | "epub"
const TYPES: Record<DocumentKind, string> = {
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  epub: "application/epub+zip",
}

export const documentKind = (hint: FileHint): DocumentKind | undefined => {
  const extension = posix
    .extname(hint.name ?? hint.path)
    .slice(1)
    .toLowerCase()
  return (Object.keys(TYPES) as DocumentKind[]).find(
    (kind) => kind === extension || TYPES[kind] === hint.mime?.split(";")[0]?.trim().toLowerCase(),
  )
}
export const documentExtractor = (kind: DocumentKind) => `document:v1:${kind}`

class Output {
  readonly parts: string[] = []
  length = 0
  real = false
  add(value: string, source = true) {
    this.length += value.length
    if (this.length > MAX_TEXT) throw new ReaderLimit()
    this.parts.push(value)
    if (source && value.trim()) this.real = true
  }
  section(label: string) {
    this.add(`\n\n[${label}]\n`, false)
  }
  text() {
    return this.parts.join("").trim()
  }
}

const attribute = (node: Element, name: string, namespace?: string) =>
  (namespace ? node.getAttributeNS(namespace, name) : node.getAttribute(name)) ?? ""
const required = (value: string) => {
  if (!value) throw new Error("missing_value")
  return value
}
const count = (value: string) => {
  if (!value) return 1
  if (!/^[1-9]\d{0,7}$/.test(value)) throw new ReaderLimit()
  return Number(value)
}
const rootIs = (node: Node, name: string, namespaces: string[]) => {
  const root = node.nodeType === 9 ? node.firstChild : node
  // XML declarations/comments can precede the document element.
  let element = root
  while (element && element.nodeType !== 1) element = element.nextSibling
  if (!element || element.localName !== name || !namespaces.includes(element.namespaceURI ?? ""))
    throw new Error("wrong_format")
  return element.namespaceURI as string
}

const target = (owner: string, reference: string) => {
  const decoded = decodeURIComponent(reference.split(/[?#]/)[0] ?? "")
  if (/^[a-z][a-z0-9+.-]*:|^[\\/]|\\/i.test(decoded) || [...decoded].some((character) => character.charCodeAt(0) < 32))
    throw new Error("external_part")
  const path = posix.normalize(posix.join(posix.dirname(owner), decoded))
  if (path.startsWith("../") || !path || path === ".") throw new Error("external_part")
  return path
}
const relationships = (archive: Map<string, Uint8Array>, owner: string) => {
  const path = owner ? posix.join(posix.dirname(owner), "_rels", `${posix.basename(owner)}.rels`) : "_rels/.rels"
  const document = xmlPart(archive, path)
  rootIs(document, "Relationships", [PACKAGE_REL])
  const result = new Map<string, { path: string; type: string }>()
  for (const entry of elements(document, "Relationship", PACKAGE_REL)) {
    if (attribute(entry, "TargetMode") === "External") continue
    const id = required(attribute(entry, "Id"))
    if (result.has(id)) throw new Error("duplicate_relationship")
    result.set(id, {
      path: target(owner, required(attribute(entry, "Target"))),
      type: required(attribute(entry, "Type")),
    })
  }
  return result
}
const relationId = (element: Element) => required(attribute(element, "id", REL) || attribute(element, "id", STRICT_REL))
const mainPart = (archive: Map<string, Uint8Array>, contentType: string) => {
  const types = xmlPart(archive, "[Content_Types].xml")
  const namespace = "http://schemas.openxmlformats.org/package/2006/content-types"
  rootIs(types, "Types", [namespace])
  const matches = [...relationships(archive, "").values()].filter((entry) => entry.type.endsWith("/officeDocument"))
  if (matches.length !== 1) throw new Error("missing_main_part")
  const path = matches[0]?.path as string
  if (
    !elements(types, "Override", namespace).some(
      (entry) => attribute(entry, "PartName") === `/${path}` && attribute(entry, "ContentType") === contentType,
    )
  )
    throw new Error("wrong_format")
  return path
}

const odfText = (node: Node): string => {
  if (node.nodeType === 3 || node.nodeType === 4) return node.nodeValue ?? ""
  if (node.nodeType === 1 && node.namespaceURI === TEXT) {
    if (node.localName === "s") {
      const repeated = count(attribute(node as Element, "c", TEXT))
      if (repeated > MAX_TEXT) throw new ReaderLimit()
      return " ".repeat(repeated)
    }
    if (node.localName === "tab") return "\t"
    if (node.localName === "line-break") return "\n"
  }
  let value = ""
  for (let child = node.firstChild; child; child = child.nextSibling) {
    value += odfText(child)
    if (value.length > MAX_TEXT) throw new ReaderLimit()
  }
  return value
}
const odfParagraphs = (node: Node): Element[] => {
  const result: Element[] = []
  const visit = (current: Node) => {
    if (
      current.nodeType === 1 &&
      current.namespaceURI === TEXT &&
      (current.localName === "p" || current.localName === "h")
    ) {
      result.push(current as Element)
      return
    }
    for (let child = current.firstChild; child; child = child.nextSibling) visit(child)
  }
  visit(node)
  return result
}
const readOdf = (archive: Map<string, Uint8Array>, kind: "odt" | "ods" | "odp", output: Output) => {
  if (new TextDecoder().decode(archive.get("mimetype")) !== TYPES[kind]) throw new Error("wrong_format")
  const document = xmlPart(archive, "content.xml")
  rootIs(document, "document-content", [OFFICE])
  if (archive.has("META-INF/manifest.xml")) {
    const manifest = xmlPart(archive, "META-INF/manifest.xml")
    if (elements(manifest, "encryption-data", "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0").length)
      throw new Error("encrypted_document")
  }
  const body = elements(document, { odt: "text", ods: "spreadsheet", odp: "presentation" }[kind], OFFICE)
  if (body.length !== 1) throw new Error("wrong_format")
  if (kind === "odt") {
    for (const paragraph of odfParagraphs(body[0] as Element)) output.add(`${odfText(paragraph)}\n`)
    return
  }
  if (kind === "odp") {
    elements(body[0] as Element, "page", ODF_DRAW).forEach((page, index) => {
      output.section(`Slide ${index + 1}`)
      for (const paragraph of odfParagraphs(page)) output.add(`${odfText(paragraph)}\n`)
    })
    return
  }
  for (const sheet of elements(body[0] as Element, "table", TABLE)) {
    output.section(`Sheet: ${required(attribute(sheet, "name", TABLE))}`)
    let rowNumber = 1
    for (const row of elements(sheet, "table-row", TABLE)) {
      const repeatedRows = count(attribute(row, "number-rows-repeated", TABLE))
      const values: { column: number; repeats: number; value: string }[] = []
      let column = 1
      for (let child = row.firstChild; child; child = child.nextSibling) {
        if (
          child.nodeType !== 1 ||
          child.namespaceURI !== TABLE ||
          !["table-cell", "covered-table-cell"].includes(child.localName ?? "")
        )
          continue
        const cell = child as Element
        const repeats = count(attribute(cell, "number-columns-repeated", TABLE))
        const paragraphs = odfParagraphs(cell).map(odfText).join("\n")
        const value =
          paragraphs ||
          attribute(cell, "string-value", OFFICE) ||
          attribute(cell, "value", OFFICE) ||
          attribute(cell, "date-value", OFFICE) ||
          attribute(cell, "time-value", OFFICE) ||
          attribute(cell, "boolean-value", OFFICE)
        const formula = attribute(cell, "formula", TABLE)
        if (value || formula)
          values.push({ column, repeats, value: `${value}${formula ? ` [formula: ${formula}]` : ""}` })
        column += repeats
      }
      if (values.length) {
        for (let repeat = 0; repeat < repeatedRows; repeat++) {
          for (const cell of values) {
            if (cell.repeats * repeatedRows * (cell.value.length + 5) > MAX_TEXT) throw new ReaderLimit()
            for (let offset = 0; offset < cell.repeats; offset++)
              output.add(`R${rowNumber + repeat}C${cell.column + offset}: ${cell.value}\n`)
          }
        }
      }
      rowNumber += repeatedRows
    }
  }
}

const readSheet = (archive: Map<string, Uint8Array>, output: Output) => {
  const path = mainPart(archive, `${TYPES.xlsx}.main+xml`)
  const document = xmlPart(archive, path)
  const namespace = rootIs(document, "workbook", [SHEET, "http://purl.oclc.org/ooxml/spreadsheetml/main"])
  const rels = relationships(archive, path)
  const shared = [...rels.values()].find((entry) => entry.type.endsWith("/sharedStrings"))
  const strings = shared
    ? elements(xmlPart(archive, shared.path), "si", namespace).map((entry) =>
        elements(entry, "t", namespace)
          .map((part) => part.textContent ?? "")
          .join(""),
      )
    : []
  for (const sheet of elements(document, "sheet", namespace)) {
    output.section(`Sheet: ${required(attribute(sheet, "name"))}`)
    const relationship = rels.get(relationId(sheet))
    if (!relationship?.type.endsWith("/worksheet")) throw new Error("missing_sheet")
    const worksheet = xmlPart(archive, relationship.path)
    rootIs(worksheet, "worksheet", [namespace])
    for (const cell of elements(worksheet, "c", namespace)) {
      const reference = required(attribute(cell, "r"))
      if (!/^[A-Z]+[1-9]\d*$/.test(reference)) throw new Error("invalid_cell")
      const type = attribute(cell, "t")
      const saved = elements(cell, "v", namespace)[0]?.textContent ?? ""
      let value =
        type === "inlineStr"
          ? elements(cell, "t", namespace)
              .map((part) => part.textContent ?? "")
              .join("")
          : saved
      if (type === "s") {
        if (!/^\d+$/.test(saved) || strings[Number(saved)] === undefined) throw new Error("missing_shared_string")
        value = strings[Number(saved)] as string
      }
      const formula = elements(cell, "f", namespace)[0]?.textContent
      if (value || formula) output.add(`${reference}: ${value}${formula ? ` [formula: ${formula}]` : ""}\n`)
    }
  }
}
const drawingText = (node: Node, namespace: string): string => {
  if (node.nodeType === 1 && node.namespaceURI === namespace) {
    if (node.localName === "t") return node.textContent ?? ""
    if (node.localName === "br") return "\n"
    if (node.localName === "tab") return "\t"
  }
  let value = ""
  for (let child = node.firstChild; child; child = child.nextSibling) {
    value += drawingText(child, namespace)
    if (value.length > MAX_TEXT) throw new ReaderLimit()
  }
  return value
}
const readSlides = (archive: Map<string, Uint8Array>, output: Output) => {
  const path = mainPart(archive, `${TYPES.pptx}.main+xml`)
  const document = xmlPart(archive, path)
  const namespace = rootIs(document, "presentation", [SLIDE, "http://purl.oclc.org/ooxml/presentationml/main"])
  const rels = relationships(archive, path)
  let number = 0
  for (const slide of elements(document, "sldId", namespace)) {
    const relationship = rels.get(relationId(slide))
    if (!relationship?.type.endsWith("/slide")) throw new Error("missing_slide")
    const content = xmlPart(archive, relationship.path)
    rootIs(content, "sld", [namespace])
    output.section(`Slide ${++number}`)
    const drawing = namespace === SLIDE ? DRAW : "http://purl.oclc.org/ooxml/drawingml/main"
    for (const paragraph of elements(content, "p", drawing)) output.add(`${drawingText(paragraph, drawing)}\n`)
  }
}

const readBook = (archive: Map<string, Uint8Array>, output: Output) => {
  if (new TextDecoder().decode(archive.get("mimetype")) !== TYPES.epub || archive.has("META-INF/encryption.xml"))
    throw new Error("wrong_format")
  const container = xmlPart(archive, "META-INF/container.xml")
  const roots = elements(container, "rootfile", "urn:oasis:names:tc:opendocument:xmlns:container")
  const root = roots.find((entry) => attribute(entry, "media-type") === "application/oebps-package+xml")
  const path = target("", required(root ? attribute(root, "full-path") : ""))
  const book = xmlPart(archive, path)
  rootIs(book, "package", [OPF])
  const manifest = new Map<string, { path: string; type: string }>()
  for (const item of elements(book, "item", OPF)) {
    const id = required(attribute(item, "id"))
    if (manifest.has(id)) throw new Error("duplicate_chapter")
    manifest.set(id, { path: target(path, required(attribute(item, "href"))), type: attribute(item, "media-type") })
  }
  let number = 0
  const chapters = elements(book, "itemref", OPF)
  if (!chapters.length) throw new Error("missing_chapters")
  for (const chapter of chapters) {
    const item = manifest.get(required(attribute(chapter, "idref")))
    if (item?.type !== "application/xhtml+xml") throw new Error("unsupported_chapter")
    const document = xmlPart(archive, item.path)
    const bodies = elements(document, "body", XHTML)
    if (bodies.length !== 1) throw new Error("missing_chapter")
    output.section(`Chapter ${++number}`)
    const visit = (node: Node) => {
      if (node.nodeType === 3 || node.nodeType === 4) {
        output.add(node.nodeValue ?? "")
        return
      }
      if (node.nodeType === 1 && ["script", "style", "head"].includes(node.localName ?? "")) return
      for (let child = node.firstChild; child; child = child.nextSibling) visit(child)
      if (node.nodeType === 1 && ["td", "th"].includes(node.localName ?? "")) output.add("\t", false)
      if (node.nodeType === 1 && ["p", "div", "li", "h1", "h2", "h3", "br", "tr"].includes(node.localName ?? ""))
        output.add("\n", false)
    }
    visit(bodies[0] as Element)
  }
}

export const readDocument = async (
  bytes: Uint8Array,
  kind: DocumentKind,
  signal?: AbortSignal,
): Promise<Extraction> => {
  const extractor = documentExtractor(kind)
  try {
    const archive = await readContainer(bytes, signal)
    const output = new Output()
    if (kind === "odt" || kind === "ods" || kind === "odp") readOdf(archive, kind, output)
    else if (kind === "xlsx") readSheet(archive, output)
    else if (kind === "pptx") readSlides(archive, output)
    else readBook(archive, output)
    if (signal?.aborted) throw new CliError("cancelled", "document extraction cancelled")
    return output.real ? { status: "extracted", extractor, text: output.text() } : { status: "needs-agent", extractor }
  } catch (error) {
    if (error instanceof CliError) throw error
    if (error instanceof ReaderLimit) return { status: "too-large" }
    return { status: "unreadable", extractor, error: "invalid_document" }
  }
}
