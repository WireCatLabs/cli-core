import { posix } from "node:path"
import { CliError } from "@wirecat/cli-base"
import type { Element, Node } from "@xmldom/xmldom"
import { elements, ReaderLimit, readContainer, xmlPart } from "./container.js"
import type { Extraction, FileHint } from "./extract.js"

import { MAX_TEXT_CHARS as MAX_TEXT } from "./limits.js"
import { type Sheet, type SheetCell, sheetText } from "./sheets.js"

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
/** v2 for spreadsheets: rows under their header instead of one line per cell, so older text is read again. */
export const documentExtractor = (kind: DocumentKind) =>
  `document:${kind === "xlsx" || kind === "ods" ? "v2" : "v1"}:${kind}`

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
const readOdf = (
  archive: Map<string, Uint8Array>,
  kind: "odt" | "ods" | "odp",
  output: Output,
): Sheet[] | undefined => {
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
    return undefined
  }
  if (kind === "odp") {
    elements(body[0] as Element, "page", ODF_DRAW).forEach((page, index) => {
      output.section(`Slide ${index + 1}`)
      for (const paragraph of odfParagraphs(page)) output.add(`${odfText(paragraph)}\n`)
    })
    return undefined
  }
  return readOds(body[0] as Element)
}

const readOds = (body: Element): Sheet[] =>
  elements(body, "table", TABLE).map((sheet) => {
    const cells: SheetCell[] = []
    let chars = 0
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
        // The paragraphs are the value as displayed; the attributes stand in when a cell has none.
        const value =
          odfParagraphs(cell).map(odfText).join("\n") ||
          attribute(cell, "string-value", OFFICE) ||
          attribute(cell, "value", OFFICE) ||
          attribute(cell, "date-value", OFFICE) ||
          attribute(cell, "time-value", OFFICE) ||
          attribute(cell, "boolean-value", OFFICE)
        if (value) values.push({ column, repeats, value })
        column += repeats
      }
      for (const cell of values) {
        chars += cell.repeats * repeatedRows * (cell.value.length + 5)
        if (chars > MAX_TEXT) throw new ReaderLimit()
        for (let repeat = 0; repeat < repeatedRows; repeat++)
          for (let offset = 0; offset < cell.repeats; offset++)
            cells.push({ row: rowNumber + repeat, column: cell.column + offset, value: cell.value })
      }
      rowNumber += repeatedRows
    }
    return { name: required(attribute(sheet, "name", TABLE)), cells }
  })

/** Built-in number formats that show a date or a time (ECMA-376 §18.8.30). */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])
const PERCENT_FORMATS = new Set([9, 10])

/** For each cell style: how its numbers are displayed. */
const numberFormats = (archive: Map<string, Uint8Array>, path: string | undefined, namespace: string) => {
  if (!path) return []
  const styles = xmlPart(archive, path)
  const custom = new Map(
    elements(styles, "numFmt", namespace).map((format) => [
      Number(attribute(format, "numFmtId")),
      attribute(format, "formatCode"),
    ]),
  )
  const formats = elements(styles, "cellXfs", namespace)[0]
  return (formats ? elements(formats, "xf", namespace) : []).map((xf): "date" | "time" | "percent" | "number" => {
    const id = Number(attribute(xf, "numFmtId"))
    const code = (custom.get(id) ?? "").replace(/"[^"]*"|\[[^\]]*\]|\\./g, "")
    if (DATE_FORMATS.has(id) || /[dy]/i.test(code)) return id >= 18 && id <= 21 ? "time" : "date"
    if (/[hs]/i.test(code)) return "time"
    if (PERCENT_FORMATS.has(id) || code.includes("%")) return "percent"
    return "number"
  })
}

const plainNumber = (value: number) => String(Number(value.toPrecision(15)))

/** A stored number as the sheet shows it: serial days as an ISO date, a fraction as a percentage. */
const displayed = (saved: string, format: "date" | "time" | "percent" | "number", base1904: boolean) => {
  const value = Number(saved)
  if (saved === "" || !Number.isFinite(value)) return saved
  if (format === "percent") return `${plainNumber(value * 100)}%`
  if (format === "number") return plainNumber(value)
  const days = value + (base1904 ? 1462 : 0)
  const iso = new Date(Date.UTC(1899, 11, 30) + Math.round(days * 86_400_000)).toISOString()
  if (format === "time" && value < 1) return iso.slice(11, 19)
  return Number.isInteger(value) ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
}

const cellAddress = (reference: string) => {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(reference)
  if (!match) throw new Error("invalid_cell")
  const column = [...(match[1] as string)].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0)
  return { row: Number(match[2]), column }
}

const readSheet = (archive: Map<string, Uint8Array>): Sheet[] => {
  const path = mainPart(archive, `${TYPES.xlsx}.main+xml`)
  const document = xmlPart(archive, path)
  const namespace = rootIs(document, "workbook", [SHEET, "http://purl.oclc.org/ooxml/spreadsheetml/main"])
  const properties = elements(document, "workbookPr", namespace)[0]
  const base1904 = properties !== undefined && ["1", "true"].includes(attribute(properties, "date1904"))
  const rels = relationships(archive, path)
  const shared = [...rels.values()].find((entry) => entry.type.endsWith("/sharedStrings"))
  const strings = shared
    ? elements(xmlPart(archive, shared.path), "si", namespace).map((entry) =>
        elements(entry, "t", namespace)
          .map((part) => part.textContent ?? "")
          .join(""),
      )
    : []
  const formats = numberFormats(
    archive,
    [...rels.values()].find((entry) => entry.type.endsWith("/styles"))?.path,
    namespace,
  )
  return elements(document, "sheet", namespace).map((sheet) => {
    const relationship = rels.get(relationId(sheet))
    if (!relationship?.type.endsWith("/worksheet")) throw new Error("missing_sheet")
    const worksheet = xmlPart(archive, relationship.path)
    rootIs(worksheet, "worksheet", [namespace])
    const cells: SheetCell[] = []
    for (const cell of elements(worksheet, "c", namespace)) {
      const { row, column } = cellAddress(required(attribute(cell, "r")))
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
      } else if (type === "" || type === "n") {
        value = displayed(saved, formats[Number(attribute(cell, "s") || 0)] ?? "number", base1904)
      } else if (type === "b") value = saved === "1" ? "TRUE" : saved === "0" ? "FALSE" : saved
      const formula = elements(cell, "f", namespace)[0]?.textContent
      cells.push({ row, column, value: value || (formula ? `=${formula}` : "") })
    }
    return { name: required(attribute(sheet, "name")), cells }
  })
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
    const sheets =
      kind === "odt" || kind === "ods" || kind === "odp"
        ? readOdf(archive, kind, output)
        : kind === "xlsx"
          ? readSheet(archive)
          : undefined
    if (sheets) {
      if (signal?.aborted) throw new CliError("cancelled", "document extraction cancelled")
      const { text, truncated } = sheetText(sheets)
      return text === ""
        ? { status: "needs-agent", extractor }
        : { status: "extracted", extractor, text, ...(truncated ? { truncated: true } : {}) }
    }
    if (kind === "pptx") readSlides(archive, output)
    else if (kind === "epub") readBook(archive, output)
    if (signal?.aborted) throw new CliError("cancelled", "document extraction cancelled")
    return output.real ? { status: "extracted", extractor, text: output.text() } : { status: "needs-agent", extractor }
  } catch (error) {
    if (error instanceof CliError) throw error
    if (error instanceof ReaderLimit) return { status: "too-large" }
    return { status: "unreadable", extractor, error: "invalid_document" }
  }
}
