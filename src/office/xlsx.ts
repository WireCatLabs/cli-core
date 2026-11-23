import { CliError } from "@wirecat/cli-base"
import { readSpreadsheet } from "../attachments/documents.js"
import { columnName } from "../attachments/sheets.js"
import {
  isSelfClosing,
  OfficePackage,
  openTag,
  type Part,
  qualified,
  REL,
  STRICT_REL,
  startTag,
  withAttribute,
  withoutAttribute,
} from "./package.js"
import { attributeOf, childrenOf, contentText, descendants, escapeText, type Splice, type XmlElement } from "./xml.js"

const MAIN = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
const SHEET_NAMESPACES = [
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  "http://purl.oclc.org/ooxml/spreadsheetml/main",
]
const CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types"
const PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
/** CT_Workbook's children after calcPr; calcPr goes before the first of them. */
const AFTER_CALC = [
  "oleSize",
  "customWorkbookViews",
  "pivotCaches",
  "smartTagPr",
  "smartTagTypes",
  "webPublishing",
  "fileRecoveryPr",
  "webPublishObjects",
  "extLst",
]
const MAX_ROW = 1_048_576
const MAX_COLUMN = 16_384

export type CellValue = string | number | boolean | null
export type CellType = "string" | "number" | "boolean" | "error" | "date" | "empty"

export interface XlsxCell {
  /** A1 style, upper case. */
  readonly address: string
  readonly row: number
  readonly column: number
  /** The stored value; for a formula cell, its last calculated result. */
  readonly value: CellValue
  readonly type: CellType
  /** The formula without `=`, when the cell holds one. */
  readonly formula?: string
  /** The index into the workbook's cell formats (`s`); 0 is the default. */
  readonly style: number
}

export interface XlsxSheet {
  readonly name: string
  readonly cells: XlsxCell[]
}

export interface ReadXlsxOptions {
  /** One sheet by its name; all sheets when left out. */
  readonly sheet?: string
  /** `B2` or `A1:C10`; every cell when left out. */
  readonly range?: string
}

export interface XlsxEdit {
  readonly sheet: string
  readonly cell: string
  /** A string is stored as text (also one that starts with `=`), `null` empties the cell and keeps its format. */
  readonly value: CellValue
}

export interface EditXlsxOptions {
  /** Replace a formula with the value; without it a formula cell is refused. */
  readonly overwriteFormulas?: boolean
}

export interface EditXlsxResult {
  readonly bytes: Uint8Array
  readonly changed: { sheet: string; cell: string; before: CellValue; after: CellValue; created: boolean }[]
  /** True when a formula was replaced, so the workbook's calculation chain was dropped for Excel to rebuild. */
  readonly calcChainDropped: boolean
}

const refuse = (message: string, reason: string) => new CliError("validation_error", message, { reason })

const parseAddress = (address: string) => {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(address.toUpperCase())
  const column = match ? [...(match[1] as string)].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) : 0
  const row = Number(match?.[2])
  if (!match || column > MAX_COLUMN || row > MAX_ROW)
    throw refuse(`${address} is not a cell address like B7`, "office.invalid_cell")
  return { row, column }
}

const parseRange = (range: string) => {
  const [from, to = from] = range.split(":") as [string, string?]
  const start = parseAddress(from)
  const end = parseAddress(to)
  return {
    top: Math.min(start.row, end.row),
    bottom: Math.max(start.row, end.row),
    left: Math.min(start.column, end.column),
    right: Math.max(start.column, end.column),
  }
}

interface SheetRef {
  readonly name: string
  readonly path: string
}

interface CellNode {
  readonly element: XmlElement
  readonly row: number
  readonly column: number
}

interface RowNode {
  readonly element: XmlElement
  readonly row: number
  readonly explicit: boolean
  readonly cells: CellNode[]
}

class Workbook {
  readonly ns: string
  readonly workbook: Part
  readonly sheets: SheetRef[]
  readonly strings: string[]
  readonly sharedPath?: string
  readonly calcChain?: { id: string; path: string }

  constructor(
    readonly pack: OfficePackage,
    readonly path: string,
  ) {
    this.workbook = pack.part(path)
    this.ns = this.workbook.root.ns
    if (this.workbook.root.local !== "workbook" || !SHEET_NAMESPACES.includes(this.ns))
      throw refuse("the file is not an Excel workbook", "office.wrong_format")
    const rels = pack.relationships(path)
    const sheetsElement = childrenOf(this.workbook.root, this.ns, "sheets")[0]
    this.sheets = (sheetsElement ? childrenOf(sheetsElement, this.ns, "sheet") : []).map((sheet) => {
      const id = attributeOf(sheet, REL, "id") ?? attributeOf(sheet, STRICT_REL, "id") ?? ""
      const target = rels.get(id)
      if (!target?.type.endsWith("/worksheet"))
        throw refuse(
          "a sheet of the workbook is not a worksheet (a chart sheet or a missing part)",
          "office.wrong_format",
        )
      return { name: attributeOf(sheet, "", "name") ?? "", path: target.path }
    })
    const shared = pack.related(path, "sharedStrings")
    this.sharedPath = shared && pack.has(shared[1].path) ? shared[1].path : undefined
    const sharedPart = this.sharedPath ? pack.part(this.sharedPath) : undefined
    this.strings = sharedPart
      ? childrenOf(sharedPart.root, this.ns, "si").map((entry) => sharedText(entry, this.ns, sharedPart.text))
      : []
    const chain = pack.related(path, "calcChain")
    if (chain) this.calcChain = { id: chain[0], path: chain[1].path }
  }

  static async open(bytes: Uint8Array) {
    const pack = await OfficePackage.open(bytes, "workbook")
    return new Workbook(pack, pack.main(MAIN))
  }

  sheet(name: string) {
    const found = this.sheets.find((sheet) => sheet.name === name)
    if (!found)
      throw refuse(
        `the workbook has no sheet "${name}"; it has ${this.sheets.map((sheet) => `"${sheet.name}"`).join(", ")}`,
        "office.no_sheet",
      )
    return found
  }
}

const sharedText = (entry: XmlElement, ns: string, text: string) => {
  const parts: string[] = []
  const visit = (element: XmlElement) => {
    for (const child of element.children) {
      if (child.ns !== ns || child.local === "rPh") continue
      if (child.local === "t") parts.push(contentText(text.slice(child.openEnd, child.closeStart)))
      else visit(child)
    }
  }
  visit(entry)
  return parts.join("")
}

const rowsOf = (sheetData: XmlElement, ns: string): RowNode[] => {
  let previous = 0
  return childrenOf(sheetData, ns, "row").map((row) => {
    const raw = attributeOf(row, "", "r")
    const number = raw ? Number(raw) : previous + 1
    previous = number
    let column = 0
    const cells = childrenOf(row, ns, "c").map((cell) => {
      const reference = attributeOf(cell, "", "r")
      if (reference) {
        const address = parseAddress(reference)
        if (address.row !== number) throw refuse(`cell ${reference} sits in row ${number}`, "office.wrong_format")
        column = address.column
      } else column++
      return { element: cell, row: number, column }
    })
    return { element: row, row: number, explicit: raw !== undefined, cells }
  })
}

const cellOf = (workbook: Workbook, text: string, node: CellNode): XlsxCell => {
  const { ns } = workbook
  const element = node.element
  const type = attributeOf(element, "", "t") ?? "n"
  const inner = (local: string) => {
    const child = childrenOf(element, ns, local)[0]
    return child ? contentText(text.slice(child.openEnd, child.closeStart)) : undefined
  }
  const saved = inner("v")
  const formulaElement = childrenOf(element, ns, "f")[0]
  const formula = formulaElement
    ? contentText(text.slice(formulaElement.openEnd, formulaElement.closeStart))
    : undefined
  let value: CellValue = null
  let kind: CellType = "empty"
  if (type === "inlineStr") {
    const is = childrenOf(element, ns, "is")[0]
    value = is
      ? descendants(is, ns, "t")
          .filter((t) => t.parent?.local !== "rPh")
          .map((t) => contentText(text.slice(t.openEnd, t.closeStart)))
          .join("")
      : ""
    kind = "string"
  } else if (saved !== undefined) {
    if (type === "s") {
      const string = workbook.strings[Number(saved)]
      if (!/^\d+$/.test(saved) || string === undefined)
        throw refuse(
          `cell ${columnName(node.column)}${node.row} points at a missing shared string`,
          "office.wrong_format",
        )
      value = string
      kind = "string"
    } else if (type === "str") {
      value = saved
      kind = "string"
    } else if (type === "b") {
      value = saved === "1" || saved === "true"
      kind = "boolean"
    } else if (type === "e") {
      value = saved
      kind = "error"
    } else if (type === "d") {
      value = saved
      kind = "date"
    } else if (saved !== "") {
      value = Number(saved)
      kind = "number"
    }
  }
  return {
    address: `${columnName(node.column)}${node.row}`,
    row: node.row,
    column: node.column,
    value,
    type: kind,
    ...(formulaElement ? { formula: formula ?? "" } : {}),
    style: Number(attributeOf(element, "", "s") ?? 0),
  }
}

const sheetDataOf = (part: Part, ns: string) => {
  if (part.root.local !== "worksheet" || part.root.ns !== ns)
    throw refuse(`${part.path} is not a worksheet`, "office.wrong_format")
  const sheetData = childrenOf(part.root, ns, "sheetData")[0]
  if (!sheetData) throw refuse(`${part.path} has no cell data`, "office.wrong_format")
  return sheetData
}

/** The workbook's sheets and their stored cells, with each cell's type, formula and format index. */
export const readXlsxCells = async (bytes: Uint8Array, options: ReadXlsxOptions = {}): Promise<XlsxSheet[]> => {
  const workbook = await Workbook.open(bytes)
  const range = options.range ? parseRange(options.range) : undefined
  const wanted = options.sheet === undefined ? workbook.sheets : [workbook.sheet(options.sheet)]
  return wanted.map((sheet) => {
    const part = workbook.pack.part(sheet.path)
    const cells = rowsOf(sheetDataOf(part, workbook.ns), workbook.ns)
      .flatMap((row) => row.cells)
      .filter(
        (cell) =>
          !range ||
          (cell.row >= range.top &&
            cell.row <= range.bottom &&
            cell.column >= range.left &&
            cell.column <= range.right),
      )
      .map((cell) => cellOf(workbook, part.text, cell))
    return { name: sheet.name, cells }
  })
}

interface Planned {
  readonly edit: XlsxEdit
  readonly row: number
  readonly column: number
  readonly address: string
}

class SharedStrings {
  private readonly added: string[] = []
  private references = 0
  private readonly plain = new Map<string, number>()

  constructor(private readonly workbook: Workbook) {
    workbook.strings.forEach((value, index) => {
      if (!this.plain.has(value)) this.plain.set(value, index)
    })
  }

  index(value: string) {
    this.references++
    const known = this.plain.get(value)
    if (known !== undefined) return known
    const index = this.workbook.strings.length + this.added.length
    this.added.push(value)
    this.plain.set(value, index)
    return index
  }

  release() {
    this.references--
  }

  write() {
    const path = this.workbook.sharedPath
    if (!path || (!this.added.length && !this.references)) return
    const part = this.workbook.pack.part(path)
    const root = part.root
    const si = qualified(root, "si")
    const t = qualified(root, "t")
    const entries = this.added
      .map((value) => `<${si}><${t} xml:space="preserve">${escapeText(value)}</${t}></${si}>`)
      .join("")
    let tag = openTag(part.text, root)
    const count = attributeOf(root, "", "count")
    const unique = attributeOf(root, "", "uniqueCount")
    if (count !== undefined) tag = withAttribute(tag, "count", String(Math.max(0, Number(count) + this.references)))
    if (unique !== undefined) tag = withAttribute(tag, "uniqueCount", String(Number(unique) + this.added.length))
    const splices: Splice[] = [{ start: root.start, end: root.openEnd, text: tag }]
    if (isSelfClosing(part.text, root))
      splices.push({ start: root.openEnd, end: root.openEnd, text: `${entries}</${root.name}>` })
    else splices.push({ start: root.closeStart, end: root.closeStart, text: entries })
    this.workbook.pack.write(part, splices)
  }
}

const valueXml = (cell: XmlElement, value: CellValue, strings: SharedStrings | undefined) => {
  const v = qualified(cell, "v")
  if (value === null) return { type: undefined, content: "" }
  if (typeof value === "boolean") return { type: "b", content: `<${v}>${value ? 1 : 0}</${v}>` }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw refuse("a cell number must be finite", "office.invalid_value")
    return { type: undefined, content: `<${v}>${String(value)}</${v}>` }
  }
  if (strings) return { type: "s", content: `<${v}>${strings.index(value)}</${v}>` }
  const is = qualified(cell, "is")
  const t = qualified(cell, "t")
  return { type: "inlineStr", content: `<${is}><${t} xml:space="preserve">${escapeText(value)}</${t}></${is}>` }
}

/** A cell's start tag: its own attributes kept, `t` set for the new value, `cm` dropped with the formula. */
const cellTag = (text: string, cell: XmlElement, type: string | undefined) => {
  let tag = withoutAttribute(withoutAttribute(startTag(text, cell), "t"), "cm")
  if (type) tag = withAttribute(tag, "t", type)
  return tag.replace(/\s*\/\s*>$/, ">")
}

const arrayRanges = (rows: RowNode[], ns: string, text: string) =>
  rows.flatMap((row) =>
    row.cells.flatMap((cell) => {
      const formula = childrenOf(cell.element, ns, "f")[0]
      const ref = formula && attributeOf(formula, "", "ref")
      return formula && ref && attributeOf(formula, "", "t") === "array"
        ? [{ master: cell, range: parseRange(ref), text: text.slice(formula.start, formula.end) }]
        : []
    }),
  )

const editSheet = (
  workbook: Workbook,
  sheet: SheetRef,
  planned: Planned[],
  options: EditXlsxOptions,
  strings?: SharedStrings,
) => {
  const { ns, pack } = workbook
  const part = pack.part(sheet.path)
  const { text } = part
  const sheetData = sheetDataOf(part, ns)
  const rows = rowsOf(sheetData, ns)
  const arrays = arrayRanges(rows, ns, text)
  const splices: Splice[] = []
  const changed: EditXlsxResult["changed"] = []
  let formulaRemoved = false
  const byRow = new Map<number, Planned[]>()
  for (const item of planned) byRow.set(item.row, [...(byRow.get(item.row) ?? []), item])

  const newCell = (item: Planned, style?: string) => {
    const { type, content } = valueXml(sheetData, item.edit.value, strings)
    const c = qualified(sheetData, "c")
    const attributes = `r="${item.address}"${style ? ` s="${style}"` : ""}${type ? ` t="${type}"` : ""}`
    return content ? `<${c} ${attributes}>${content}</${c}>` : `<${c} ${attributes}/>`
  }

  for (const [rowNumber, items] of [...byRow].sort(([a], [b]) => a - b)) {
    items.sort((a, b) => a.column - b.column)
    const row = rows.find((candidate) => candidate.row === rowNumber)
    if (!row) {
      if (rows.some((candidate) => !candidate.explicit))
        throw refuse(
          `${sheet.name} has rows without numbers, so row ${rowNumber} cannot be added`,
          "office.implicit_rows",
        )
      const next = rows.find((candidate) => candidate.row > rowNumber)
      const r = qualified(sheetData, "row")
      const xml = `<${r} r="${rowNumber}">${items.map((item) => newCell(item)).join("")}</${r}>`
      for (const item of items)
        changed.push({ sheet: sheet.name, cell: item.address, before: null, after: item.edit.value, created: true })
      if (next) splices.push({ start: next.element.start, end: next.element.start, text: xml })
      else if (isSelfClosing(text, sheetData))
        splices.push({
          start: sheetData.start,
          end: sheetData.end,
          text: `${openTag(text, sheetData)}${xml}</${sheetData.name}>`,
        })
      else splices.push({ start: sheetData.closeStart, end: sheetData.closeStart, text: xml })
      continue
    }
    const inserts: { at: number; xml: string }[] = []
    const rowStyle =
      attributeOf(row.element, "", "customFormat") === "1" ? attributeOf(row.element, "", "s") : undefined
    for (const item of items) {
      const existing = row.cells.find((cell) => cell.column === item.column)
      if (!existing) {
        if (row.cells.some((cell) => attributeOf(cell.element, "", "r") === undefined))
          throw refuse(
            `row ${rowNumber} of ${sheet.name} has cells without addresses, so ${item.address} cannot be added`,
            "office.implicit_cells",
          )
        const next = row.cells.find((cell) => cell.column > item.column)
        inserts.push({ at: next ? next.element.start : -1, xml: newCell(item, rowStyle) })
        changed.push({ sheet: sheet.name, cell: item.address, before: null, after: item.edit.value, created: true })
        continue
      }
      const before = cellOf(workbook, text, existing)
      const element = existing.element
      if (attributeOf(element, "", "vm") !== undefined)
        throw refuse(
          `${sheet.name}!${item.address} holds a picture or a linked data type, which this editor does not replace`,
          "office.rich_value",
        )
      const formula = childrenOf(element, ns, "f")[0]
      const array = arrays.find(
        (entry) =>
          item.row >= entry.range.top &&
          item.row <= entry.range.bottom &&
          item.column >= entry.range.left &&
          item.column <= entry.range.right &&
          (entry.range.top !== entry.range.bottom || entry.range.left !== entry.range.right),
      )
      if (array)
        throw refuse(
          `${sheet.name}!${item.address} is part of an array formula; change it in Excel`,
          "office.array_formula",
        )
      if (formula) {
        if (!options.overwriteFormulas)
          throw refuse(
            `${sheet.name}!${item.address} holds the formula =${before.formula}; pass overwriteFormulas to replace it with a value`,
            "office.formula_cell",
          )
        if (attributeOf(formula, "", "t") === "shared" && attributeOf(formula, "", "ref") !== undefined)
          throw refuse(
            `${sheet.name}!${item.address} holds a formula that other cells share; replacing it would break theirs`,
            "office.shared_formula",
          )
        formulaRemoved = true
      }
      if (attributeOf(element, "", "t") === "s" && strings) strings.release()
      const { type, content } = valueXml(element, item.edit.value, strings)
      const extra = childrenOf(element, ns, "extLst")
        .map((child) => text.slice(child.start, child.end))
        .join("")
      const tag = cellTag(text, element, type)
      splices.push({ start: element.start, end: element.end, text: `${tag}${content}${extra}</${element.name}>` })
      changed.push({
        sheet: sheet.name,
        cell: item.address,
        before: before.value,
        after: item.edit.value,
        created: false,
      })
    }
    if (inserts.length) {
      const tail = inserts
        .filter((insert) => insert.at < 0)
        .map((insert) => insert.xml)
        .join("")
      for (const insert of inserts.filter((entry) => entry.at >= 0))
        splices.push({ start: insert.at, end: insert.at, text: insert.xml })
      if (tail) {
        if (isSelfClosing(text, row.element))
          splices.push({
            start: row.element.start,
            end: row.element.end,
            text: `${openTag(text, row.element)}${tail}</${row.element.name}>`,
          })
        else splices.push({ start: row.element.closeStart, end: row.element.closeStart, text: tail })
      }
    }
  }
  const created = changed.filter((entry) => entry.created).map((entry) => parseAddress(entry.cell))
  const dimension = childrenOf(part.root, ns, "dimension")[0]
  const ref = dimension && attributeOf(dimension, "", "ref")
  if (dimension && ref && created.length) {
    const current = parseRange(ref)
    const grown = created.reduce(
      (box, cell) => ({
        top: Math.min(box.top, cell.row),
        bottom: Math.max(box.bottom, cell.row),
        left: Math.min(box.left, cell.column),
        right: Math.max(box.right, cell.column),
      }),
      current,
    )
    if (
      grown.top !== current.top ||
      grown.bottom !== current.bottom ||
      grown.left !== current.left ||
      grown.right !== current.right
    ) {
      const a1 = `${columnName(grown.left)}${grown.top}`
      const b2 = `${columnName(grown.right)}${grown.bottom}`
      splices.push({
        start: dimension.start,
        end: dimension.openEnd,
        text: withAttribute(startTag(text, dimension), "ref", a1 === b2 ? a1 : `${a1}:${b2}`),
      })
    }
  }
  pack.write(part, splices)
  return { changed, formulaRemoved }
}

const markRecalculation = (workbook: Workbook) => {
  const { workbook: part, ns } = workbook
  const { root, text } = part
  const calcPr = childrenOf(root, ns, "calcPr")[0]
  if (calcPr) {
    if (attributeOf(calcPr, "", "fullCalcOnLoad") === "1") return
    workbook.pack.write(part, [
      { start: calcPr.start, end: calcPr.openEnd, text: withAttribute(startTag(text, calcPr), "fullCalcOnLoad", "1") },
    ])
    return
  }
  const next = root.children.find((child) => child.ns === ns && AFTER_CALC.includes(child.local))
  const xml = `<${qualified(root, "calcPr")} fullCalcOnLoad="1"/>`
  const at = next ? next.start : root.closeStart
  workbook.pack.write(part, [{ start: at, end: at, text: xml }])
}

const dropCalcChain = (workbook: Workbook) => {
  const chain = workbook.calcChain
  if (!chain) return false
  const { pack } = workbook
  const relsPath = workbook.path.replace(/([^/]+)$/, "_rels/$1.rels")
  const rels = pack.part(relsPath)
  const relation = childrenOf(rels.root, PACKAGE_REL, "Relationship").find(
    (entry) => attributeOf(entry, "", "Id") === chain.id,
  )
  if (relation) pack.write(rels, [{ start: relation.start, end: relation.end, text: "" }])
  const types = pack.part("[Content_Types].xml")
  const override = childrenOf(types.root, CONTENT_TYPES, "Override").find(
    (entry) => attributeOf(entry, "", "PartName") === `/${chain.path}`,
  )
  if (override) pack.write(types, [{ start: override.start, end: override.end, text: "" }])
  if (pack.has(chain.path)) pack.remove(chain.path)
  return true
}

const same = (left: CellValue, right: CellValue) => left === right || (left === "" && right === null)

/**
 * Changes cells in place. Only the edited worksheets, the shared strings and the workbook part (marked to recalculate
 * on open) are rewritten, each by splicing the changed elements into its original text; every other zip entry is
 * copied byte for byte. A new cell or row goes in address order; an edited cell keeps its format (`s`).
 */
export const editXlsxCells = async (
  bytes: Uint8Array,
  edits: readonly XlsxEdit[],
  options: EditXlsxOptions = {},
): Promise<EditXlsxResult> => {
  const workbook = await Workbook.open(bytes)
  const bySheet = new Map<SheetRef, Planned[]>()
  const seen = new Set<string>()
  for (const edit of edits) {
    const sheet = workbook.sheet(edit.sheet)
    const { row, column } = parseAddress(edit.cell)
    const address = `${columnName(column)}${row}`
    const key = `${sheet.name}!${address}`
    if (seen.has(key)) throw refuse(`${key} is edited twice in one call`, "office.duplicate_edit")
    seen.add(key)
    bySheet.set(sheet, [...(bySheet.get(sheet) ?? []), { edit, row, column, address }])
  }
  if (!edits.length) return { bytes: bytes.slice(), changed: [], calcChainDropped: false }
  const strings = workbook.sharedPath ? new SharedStrings(workbook) : undefined
  let changed: EditXlsxResult["changed"] = []
  let formulaRemoved = false
  for (const [sheet, planned] of bySheet) {
    const result = editSheet(workbook, sheet, planned, options, strings)
    changed = changed.concat(result.changed)
    formulaRemoved ||= result.formulaRemoved
  }
  strings?.write()
  markRecalculation(workbook)
  const calcChainDropped = formulaRemoved && dropCalcChain(workbook)
  const output = workbook.pack.build()
  await verify(output, changed)
  return { bytes: output, changed, calcChainDropped }
}

const verify = async (output: Uint8Array, changed: EditXlsxResult["changed"]) => {
  const sheets = await readXlsxCells(output)
  for (const entry of changed) {
    const cell = sheets
      .find((sheet) => sheet.name === entry.sheet)
      ?.cells.find((candidate) => candidate.address === entry.cell)
    if (!same(cell?.value ?? null, entry.after) || cell?.formula !== undefined)
      throw new Error(`the edited workbook does not read back ${entry.sheet}!${entry.cell} as written`)
  }
  await readSpreadsheet(output, "xlsx")
}
