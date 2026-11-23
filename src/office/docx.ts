import { CliError } from "@wirecat/cli-base"
import { OfficePackage, openTag, type Part, qualified } from "./package.js"
import { attributeOf, childrenOf, contentText, escapeText, type Splice, type XmlElement } from "./xml.js"

const MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
const WORD_NAMESPACES = [
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]

export interface DocxParagraph {
  /** Position among the body's paragraphs, table cells included, in document order; edits address it. */
  readonly index: number
  readonly text: string
  readonly styleId?: string
  /** The style's display name from styles.xml, such as "Heading 1". */
  readonly style?: string
  readonly location: "body" | "table"
  /** Whether `editDocxParagraphs` may replace or delete it; `reason` says why not. */
  readonly editable: boolean
  readonly reason?: string
  /** Runs with different formatting: replacing the text collapses them to the first run's formatting. */
  readonly mixedFormatting: boolean
}

export type DocxEdit =
  | { readonly index: number; readonly text: string }
  /** `insertAfter: -1` puts the paragraph before the first one. `styleFrom` defaults to the neighbour. */
  | { readonly insertAfter: number; readonly text: string; readonly styleFrom?: number }
  | { readonly delete: number }

export interface EditDocxResult {
  readonly bytes: Uint8Array
  readonly replaced: number[]
  readonly inserted: number
  readonly deleted: number[]
  /** Replaced paragraphs whose mixed inline formatting (bold words, links of colour) became the first run's. */
  readonly collapsed: number[]
}

const refuse = (message: string, reason: string) => new CliError("validation_error", message, { reason })

/** Run content that is plain text; anything else in a run makes the paragraph read-only. */
const RUN_TEXT = new Set(["rPr", "t", "tab", "br", "cr", "noBreakHyphen", "softHyphen", "lastRenderedPageBreak"])
const RUN_REASONS: Record<string, string> = {
  drawing: "an image or a drawing",
  pict: "an image or a drawing",
  object: "an embedded object",
  fldChar: "a field",
  instrText: "a field",
  footnoteReference: "a footnote reference",
  endnoteReference: "an endnote reference",
  footnoteRef: "a footnote mark",
  endnoteRef: "an endnote mark",
  commentReference: "a comment",
  annotationRef: "a comment",
  delText: "a tracked change",
  delInstrText: "a tracked change",
  sym: "a symbol",
  ruby: "ruby text",
  ptab: "a positional tab",
  separator: "a footnote separator",
  continuationSeparator: "a footnote separator",
}
const PARAGRAPH_REASONS: Record<string, string> = {
  ins: "a tracked change",
  del: "a tracked change",
  moveFrom: "a tracked change",
  moveTo: "a tracked change",
  moveFromRangeStart: "a tracked change",
  moveFromRangeEnd: "a tracked change",
  moveToRangeStart: "a tracked change",
  moveToRangeEnd: "a tracked change",
  commentRangeStart: "a comment",
  commentRangeEnd: "a comment",
  hyperlink: "a hyperlink",
  fldSimple: "a field",
  sdt: "a content control",
  smartTag: "a smart tag",
  customXml: "custom XML markup",
  subDoc: "a subdocument",
  oMath: "an equation",
  oMathPara: "an equation",
}
/** Kept in place of the old runs: bookmark starts go first, ends last, so cross-references still find them. */
const MARKERS = new Set(["bookmarkStart", "bookmarkEnd", "permStart", "permEnd"])
const TRACKED_PROPERTIES = new Set(["pPrChange", "rPrChange", "ins", "del", "moveFrom", "moveTo"])
const CONTAINERS = new Set(["tbl", "tr", "tc", "sdt", "sdtContent", "customXml"])

interface Found {
  readonly element: XmlElement
  readonly location: "body" | "table"
  readonly lockedControl: boolean
}

const hasTracked = (element: XmlElement | undefined): boolean =>
  !!element?.children.some((child) => TRACKED_PROPERTIES.has(child.local) || hasTracked(child))

class Document {
  readonly ns: string
  readonly part: Part
  readonly found: Found[] = []
  readonly styles = new Map<string, string>()

  constructor(readonly pack: OfficePackage) {
    this.part = pack.part(pack.main(MAIN))
    const root = this.part.root
    this.ns = root.ns
    if (root.local !== "document" || !WORD_NAMESPACES.includes(this.ns))
      throw refuse("the file is not a Word document", "office.wrong-format")
    const body = childrenOf(root, this.ns, "body")[0]
    if (!body) throw refuse("the document has no body", "office.wrong-format")
    this.walk(body, "body", false)
    const styles = pack.related(this.part.path, "styles")
    if (styles && pack.has(styles[1].path)) {
      const part = pack.part(styles[1].path)
      for (const style of childrenOf(part.root, this.ns, "style")) {
        const id = attributeOf(style, this.ns, "styleId")
        const name = childrenOf(style, this.ns, "name")[0]
        if (id && name) this.styles.set(id, attributeOf(name, this.ns, "val") ?? id)
      }
    }
  }

  static async open(bytes: Uint8Array) {
    return new Document(await OfficePackage.open(bytes, "Word document"))
  }

  private walk(container: XmlElement, location: "body" | "table", locked: boolean) {
    for (const child of container.children) {
      if (child.ns !== this.ns) continue
      if (child.local === "p") this.found.push({ element: child, location, lockedControl: locked })
      else if (CONTAINERS.has(child.local)) {
        const properties = child.local === "sdt" ? childrenOf(child, this.ns, "sdtPr")[0] : undefined
        const lock = properties && childrenOf(properties, this.ns, "lock")[0]
        const lockValue = lock && attributeOf(lock, this.ns, "val")
        const controlLocked =
          !!properties &&
          (lockValue === "contentLocked" ||
            lockValue === "sdtContentLocked" ||
            properties.children.some((entry) => entry.local === "dataBinding"))
        this.walk(child, child.local === "tbl" ? "table" : location, locked || controlLocked)
      }
    }
  }

  private raw(element: XmlElement) {
    return this.part.text.slice(element.start, element.end)
  }

  /** Why a paragraph cannot be rewritten, or undefined when it holds only plain runs. */
  reasonOf(found: Found) {
    if (found.lockedControl) return "it sits in a locked or data-bound content control"
    for (const child of found.element.children) {
      if (child.ns !== this.ns) return child.local === "AlternateContent" ? "an image or a drawing" : `<${child.name}>`
      if (child.local === "pPr") {
        if (hasTracked(child)) return "a tracked change"
        continue
      }
      if (child.local === "proofErr" || MARKERS.has(child.local)) continue
      if (child.local !== "r") return PARAGRAPH_REASONS[child.local] ?? `<${child.name}>`
      for (const part of child.children) {
        if (part.ns !== this.ns) return part.local === "AlternateContent" ? "an image or a drawing" : `<${part.name}>`
        if (part.local === "rPr" && hasTracked(part)) return "a tracked change"
        if (part.local === "br" && ["page", "column"].includes(attributeOf(part, this.ns, "type") ?? ""))
          return "a page or column break"
        if (!RUN_TEXT.has(part.local)) return RUN_REASONS[part.local] ?? `<${part.name}>`
      }
    }
    return undefined
  }

  textOf(element: XmlElement): string {
    let text = ""
    for (const child of element.children) {
      if (child.ns !== this.ns) continue
      if (child.local === "t") text += contentText(this.part.text.slice(child.openEnd, child.closeStart))
      else if (child.local === "tab") text += "\t"
      else if (child.local === "br" || child.local === "cr") text += "\n"
      else if (child.local === "noBreakHyphen") text += "‑"
      else if (child.local === "softHyphen") text += "­"
      else if (!["pPr", "rPr", "del", "moveFrom", "drawing", "pict", "object", "instrText"].includes(child.local))
        text += this.textOf(child)
    }
    return text
  }

  private runs(element: XmlElement) {
    return childrenOf(element, this.ns, "r")
  }

  /** The formatting a rewritten paragraph's single run takes: the first run that holds text. */
  firstRunProperties(element: XmlElement) {
    const runs = this.runs(element)
    const run = runs.find((candidate) => this.textOf(candidate) !== "") ?? runs[0]
    const properties = run && childrenOf(run, this.ns, "rPr")[0]
    return properties ? this.raw(properties) : ""
  }

  mixed(element: XmlElement) {
    const formats = new Set(
      this.runs(element)
        .filter((run) => this.textOf(run) !== "")
        .map((run) => {
          const properties = childrenOf(run, this.ns, "rPr")[0]
          return properties ? this.raw(properties) : ""
        }),
    )
    return formats.size > 1
  }

  paragraphs(): DocxParagraph[] {
    return this.found.map((found, index) => {
      const element = found.element
      const properties = childrenOf(element, this.ns, "pPr")[0]
      const styleElement = properties && childrenOf(properties, this.ns, "pStyle")[0]
      const styleId = styleElement && attributeOf(styleElement, this.ns, "val")
      const reason = this.reasonOf(found)
      const style = styleId && this.styles.get(styleId)
      return {
        index,
        text: this.textOf(element),
        ...(styleId ? { styleId } : {}),
        ...(style ? { style } : {}),
        location: found.location,
        editable: reason === undefined,
        ...(reason === undefined
          ? {}
          : {
              reason: reason.startsWith("<")
                ? `unsupported element ${reason}`
                : reason.startsWith("it ")
                  ? reason
                  : `it holds ${reason}`,
            }),
        mixedFormatting: this.mixed(element),
      }
    })
  }

  /** The paragraph properties without a section break, which must not be copied into a new paragraph. */
  propertiesForCopy(element: XmlElement) {
    const properties = childrenOf(element, this.ns, "pPr")[0]
    if (!properties) return ""
    if (hasTracked(properties))
      throw refuse("the paragraph to copy the style from holds a tracked change", "office.tracked-change")
    let raw = this.raw(properties)
    for (const section of childrenOf(properties, this.ns, "sectPr").reverse())
      raw = raw.slice(0, section.start - properties.start) + raw.slice(section.end - properties.start)
    return raw
  }

  runsXml(element: XmlElement, text: string, runProperties: string) {
    if (!text) return ""
    const r = qualified(element, "r")
    const t = qualified(element, "t")
    const content = text
      .split(/(\n|\t)/)
      .filter((piece) => piece !== "")
      .map((piece) =>
        piece === "\n"
          ? `<${qualified(element, "br")}/>`
          : piece === "\t"
            ? `<${qualified(element, "tab")}/>`
            : `<${t} xml:space="preserve">${escapeText(piece)}</${t}>`,
      )
      .join("")
    return `<${r}>${runProperties}${content}</${r}>`
  }

  rewritten(element: XmlElement, text: string) {
    const properties = childrenOf(element, this.ns, "pPr")[0]
    const markers = element.children.filter((child) => child.ns === this.ns && MARKERS.has(child.local))
    const starts = markers.filter((marker) => marker.local.endsWith("Start")).map((marker) => this.raw(marker))
    const ends = markers.filter((marker) => marker.local.endsWith("End")).map((marker) => this.raw(marker))
    return `${openTag(this.part.text, element)}${properties ? this.raw(properties) : ""}${starts.join("")}${this.runsXml(element, text, this.firstRunProperties(element))}${ends.join("")}</${element.name}>`
  }
}

/** The body's paragraphs, table cells included, with their style and whether the editor can change them. */
export const readDocxParagraphs = async (bytes: Uint8Array): Promise<DocxParagraph[]> =>
  (await Document.open(bytes)).paragraphs()

const normalized = (text: string) => text.replace(/\r\n?/g, "\n")

/**
 * Edits paragraph text in place: only document.xml is rewritten, by splicing the edited paragraphs into its original
 * text, and every other zip entry is copied byte for byte. Indexes refer to the document as it was read. A replaced
 * paragraph keeps its properties (style, numbering, alignment) and its first text run's formatting; the rest of its
 * inline formatting collapses to that (listed in `collapsed`).
 */
export const editDocxParagraphs = async (bytes: Uint8Array, edits: readonly DocxEdit[]): Promise<EditDocxResult> => {
  const document = await Document.open(bytes)
  const { found } = document
  const infos = document.paragraphs()
  const check = (index: number, what: string) => {
    if (!Number.isInteger(index) || index < 0 || index >= found.length)
      throw refuse(
        `${what} ${index} does not exist; the document has ${found.length} paragraphs`,
        "office.no-paragraph",
      )
    return found[index] as Found
  }
  const editable = (index: number, action: string) => {
    const info = infos[index] as DocxParagraph
    if (!info.editable)
      throw refuse(`paragraph ${index} cannot be ${action}: ${info.reason}`, "office.unsafe-paragraph")
  }
  const touched = new Set<number>()
  const once = (index: number) => {
    if (touched.has(index)) throw refuse(`paragraph ${index} is changed twice in one call`, "office.duplicate-edit")
    touched.add(index)
  }
  const splices: Splice[] = []
  const replaced: number[] = []
  const deleted: number[] = []
  const collapsed: number[] = []
  const expected: (string | undefined)[] = infos.map((info) => info.text)
  const insertedAfter = new Map<number, string[]>()
  let inserted = 0
  for (const edit of edits) {
    if ("delete" in edit) {
      const target = check(edit.delete, "paragraph")
      once(edit.delete)
      editable(edit.delete, "deleted")
      const properties = childrenOf(target.element, document.ns, "pPr")[0]
      if (properties && childrenOf(properties, document.ns, "sectPr").length)
        throw refuse(
          `paragraph ${edit.delete} ends a section; deleting it would merge two sections`,
          "office.section-break",
        )
      if (target.element.children.some((child) => MARKERS.has(child.local)))
        throw refuse(`paragraph ${edit.delete} holds a bookmark that a cross-reference may point at`, "office.bookmark")
      splices.push({ start: target.element.start, end: target.element.end, text: "" })
      deleted.push(edit.delete)
      expected[edit.delete] = undefined
    } else if ("index" in edit) {
      const target = check(edit.index, "paragraph")
      once(edit.index)
      editable(edit.index, "replaced")
      const text = normalized(edit.text)
      splices.push({
        start: target.element.start,
        end: target.element.end,
        text: document.rewritten(target.element, text),
      })
      replaced.push(edit.index)
      if ((infos[edit.index] as DocxParagraph).mixedFormatting) collapsed.push(edit.index)
      expected[edit.index] = text
    } else {
      if (edit.insertAfter !== -1) check(edit.insertAfter, "paragraph")
      if (!found.length) throw refuse("the document has no paragraph to insert next to", "office.no-paragraph")
      const neighbour = found[Math.max(0, edit.insertAfter)] as Found
      if (neighbour.lockedControl)
        throw refuse(`paragraph ${edit.insertAfter} sits in a locked content control`, "office.unsafe-paragraph")
      const source = check(edit.styleFrom ?? Math.max(0, edit.insertAfter), "styleFrom paragraph").element
      const element = neighbour.element
      const text = normalized(edit.text)
      const p = qualified(element, "p")
      const xml = `<${p}>${document.propertiesForCopy(source)}${document.runsXml(element, text, document.firstRunProperties(source))}</${p}>`
      const at = edit.insertAfter === -1 ? element.start : element.end
      splices.push({ start: at, end: at, text: xml })
      insertedAfter.set(edit.insertAfter, [...(insertedAfter.get(edit.insertAfter) ?? []), text])
      inserted++
    }
  }
  // Word and LibreOffice expect a paragraph after the last table of the body or a cell; LibreOffice's text export
  // loops on a body that ends in a table.
  const containers = new Set(deleted.map((index) => found[index]?.element.parent))
  for (const container of containers) {
    if (!container || !["tc", "body"].includes(container.local)) continue
    const blocks = container.children.filter(
      (child) => child.ns === document.ns && ["p", "tbl", "sdt", "customXml"].includes(child.local),
    )
    const remaining = blocks.filter((block) => !deleted.includes(found.findIndex((entry) => entry.element === block)))
    const addsAtEnd = found.some((entry, index) => insertedAfter.has(index) && entry.element === blocks.at(-1))
    if (!addsAtEnd && remaining.at(-1)?.local !== "p")
      throw refuse(
        `${container.local === "tc" ? "a table cell" : "the document"} must end with a paragraph; this delete would leave it without one`,
        "office.last-paragraph",
      )
  }
  if (!edits.length) return { bytes: bytes.slice(), replaced, inserted, deleted, collapsed }
  document.pack.write(document.part, splices)
  const output = document.pack.build()
  const after = (await readDocxParagraphs(output)).map((paragraph) => paragraph.text)
  const want = [
    ...(insertedAfter.get(-1) ?? []),
    ...expected.flatMap((text, index) => [...(text === undefined ? [] : [text]), ...(insertedAfter.get(index) ?? [])]),
  ]
  if (after.length !== want.length || after.some((text, index) => text !== want[index]))
    throw new Error("the edited document does not read back as written")
  return { bytes: output, replaced, inserted, deleted, collapsed }
}
