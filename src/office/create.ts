import { CliError } from "@wirecat/cli-base"
import { strToU8, zipSync } from "fflate"
import { columnName } from "../attachments/sheets.js"
import { escapeAttribute } from "./package.js"
import type { CellValue } from "./xlsx.js"
import { escapeText } from "./xml.js"

const MAX_ROW = 1_048_576
const MAX_COLUMN = 16_384
const MAX_CELL_TEXT = 32_767
const MAX_FORMULA = 8_192
const MAX_TABLE_COLUMNS = 63

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types"
const PACKAGE_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const OPENXML = "application/vnd.openxmlformats-officedocument"

const refuse = (message: string, reason: string) => new CliError("validation_error", message, { reason })

const packed = (parts: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(parts).map(([path, text]) => [path, strToU8(XML + text)])), {
    level: 6,
    // fflate stores the time with local getters: a date made here from local fields is the same in every time zone.
    mtime: new Date(1980, 0, 1),
  })

const contentTypes = (overrides: Record<string, string>) =>
  `<Types xmlns="${CONTENT_TYPES}">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  Object.entries(overrides)
    .map(([part, type]) => `<Override PartName="/${part}" ContentType="${OPENXML}.${type}"/>`)
    .join("") +
  "</Types>"

const relationships = (entries: [type: string, target: string][]) =>
  `<Relationships xmlns="${PACKAGE_REL}">` +
  entries
    .map(
      ([type, target], index) => `<Relationship Id="rId${index + 1}" Type="${OFFICE_REL}/${type}" Target="${target}"/>`,
    )
    .join("") +
  "</Relationships>"

/** A formula without a cached result, computed when the file opens; `=` in front is optional. */
export interface NewFormulaCell {
  readonly formula: string
  readonly bold?: boolean
}

/** A value with formatting; a text that starts with `=` stays text here too. */
export interface NewValueCell {
  readonly value: CellValue
  readonly bold?: boolean
}

export type NewCell = CellValue | NewFormulaCell | NewValueCell

export interface NewSheet {
  /** 1 to 31 characters, none of `[]:*?/\`, not starting or ending with `'`; unique in the workbook, ignoring case. */
  readonly name: string
  /** Rows from A1 down; `null` leaves a cell empty. */
  readonly rows: readonly (readonly NewCell[])[]
  /** This sheet's first row in bold. */
  readonly header?: boolean
}

export interface CreateXlsxOptions {
  readonly sheets: readonly NewSheet[]
  /** The first row of every sheet in bold. */
  readonly boldHeader?: boolean
}

const checkSheetNames = (sheets: readonly NewSheet[]) => {
  if (!sheets.length) throw refuse("a workbook needs at least one sheet", "office.invalid-sheet-name")
  const seen = new Set<string>()
  for (const { name } of sheets) {
    if (!name || name.length > 31 || /[[\]:*?/\\]/u.test(name) || name.startsWith("'") || name.endsWith("'"))
      throw refuse(
        `"${name}" cannot name a sheet: 1 to 31 characters, none of [ ] : * ? / \\, not starting or ending with '`,
        "office.invalid-sheet-name",
      )
    escapeText(name)
    const folded = name.toLocaleLowerCase("en")
    if (seen.has(folded)) throw refuse(`two sheets are named "${name}"`, "office.invalid-sheet-name")
    seen.add(folded)
  }
}

class SharedStrings {
  private readonly indexes = new Map<string, number>()
  count = 0

  index(text: string) {
    this.count++
    const known = this.indexes.get(text)
    if (known !== undefined) return known
    this.indexes.set(text, this.indexes.size)
    return this.indexes.size - 1
  }

  get size() {
    return this.indexes.size
  }

  xml() {
    const items = [...this.indexes.keys()].map((text) => `<si><t xml:space="preserve">${escapeText(text)}</t></si>`)
    return `<sst xmlns="${SHEET_NS}" count="${this.count}" uniqueCount="${this.size}">${items.join("")}</sst>`
  }
}

const formulaXml = (address: string, formula: string, style: string) => {
  const text = formula.startsWith("=") ? formula.slice(1) : formula
  if (!text.trim()) throw refuse(`${address}: a formula cannot be empty`, "office.invalid-value")
  if (text.length > MAX_FORMULA)
    throw refuse(`${address}: a formula holds at most 8,192 characters`, "office.invalid-value")
  return `<c r="${address}"${style}><f>${escapeText(text)}</f></c>`
}

const cellXml = (address: string, value: Exclude<CellValue, null>, style: string, strings: SharedStrings) => {
  if (typeof value === "boolean") return `<c r="${address}"${style} t="b"><v>${value ? 1 : 0}</v></c>`
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw refuse(`${address}: a cell number must be finite`, "office.invalid-value")
    return `<c r="${address}"${style}><v>${String(value)}</v></c>`
  }
  if (value.length > MAX_CELL_TEXT)
    throw refuse(`${address}: a cell holds at most 32,767 characters`, "office.invalid-value")
  return `<c r="${address}"${style} t="s"><v>${strings.index(value)}</v></c>`
}

const worksheetXml = (sheet: NewSheet, strings: SharedStrings, boldHeader: boolean, formulas: { count: number }) => {
  if (sheet.rows.length > MAX_ROW)
    throw refuse(`sheet "${sheet.name}" has more than 1,048,576 rows`, "office.invalid-cell")
  let right = 0
  let bottom = 0
  const rows = sheet.rows.flatMap((values, down) => {
    if (values.length > MAX_COLUMN)
      throw refuse(`row ${down + 1} of "${sheet.name}" has more than 16,384 cells`, "office.invalid-cell")
    const header = (boldHeader || sheet.header === true) && down === 0
    const cells = values.flatMap((cell, across) => {
      const formatted = cell !== null && typeof cell === "object"
      const value = formatted ? ("formula" in cell ? undefined : cell.value) : cell
      if (value === null) return []
      right = Math.max(right, across + 1)
      const address = `${columnName(across + 1)}${down + 1}`
      const style = header || (formatted && cell.bold === true) ? ' s="1"' : ""
      if (formatted && "formula" in cell) {
        formulas.count++
        return [formulaXml(address, cell.formula, style)]
      }
      return [cellXml(address, value as Exclude<CellValue, null>, style, strings)]
    })
    if (!cells.length) return []
    bottom = down + 1
    return [`<row r="${down + 1}">${cells.join("")}</row>`]
  })
  const dimension = bottom ? `A1:${columnName(right)}${bottom}` : "A1"
  const data = rows.length ? `<sheetData>${rows.join("")}</sheetData>` : "<sheetData/>"
  return `<worksheet xmlns="${SHEET_NS}" xmlns:r="${OFFICE_REL}"><dimension ref="${dimension}"/>${data}</worksheet>`
}

// Excel repairs a workbook whose styles lack the two default fills or a border; font 1 and format 1 are the bold header.
const STYLES =
  `<styleSheet xmlns="${SHEET_NS}">` +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>"

/**
 * A new workbook with these sheets and values: strings in a shared strings part (a string that starts with `=` stays
 * text), numbers and booleans typed, `{formula}` a formula. No document properties, so the same input gives the same
 * bytes.
 */
export const createXlsx = (options: CreateXlsxOptions): Uint8Array => {
  const { sheets, boldHeader = false } = options
  checkSheetNames(sheets)
  const strings = new SharedStrings()
  const formulas = { count: 0 }
  const parts: Record<string, string> = {}
  const types: Record<string, string> = { "xl/workbook.xml": "spreadsheetml.sheet.main+xml" }
  sheets.forEach((sheet, index) => {
    parts[`xl/worksheets/sheet${index + 1}.xml`] = worksheetXml(sheet, strings, boldHeader, formulas)
    types[`xl/worksheets/sheet${index + 1}.xml`] = "spreadsheetml.worksheet+xml"
  })
  types["xl/styles.xml"] = "spreadsheetml.styles+xml"
  const links: [string, string][] = [
    ...sheets.map((_, index): [string, string] => ["worksheet", `worksheets/sheet${index + 1}.xml`]),
    ["styles", "styles.xml"],
  ]
  if (strings.size) {
    types["xl/sharedStrings.xml"] = "spreadsheetml.sharedStrings+xml"
    links.push(["sharedStrings", "sharedStrings.xml"])
  }
  const listed = sheets
    .map(
      (sheet, index) => `<sheet name="${escapeAttribute(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join("")
  // No cached results are written, so Excel and LibreOffice must compute every formula as the file opens.
  const calculation = formulas.count ? '<calcPr calcId="191029" fullCalcOnLoad="1"/>' : ""
  return packed({
    "[Content_Types].xml": contentTypes(types),
    "_rels/.rels": relationships([["officeDocument", "xl/workbook.xml"]]),
    "xl/workbook.xml": `<workbook xmlns="${SHEET_NS}" xmlns:r="${OFFICE_REL}"><sheets>${listed}</sheets>${calculation}</workbook>`,
    "xl/_rels/workbook.xml.rels": relationships(links),
    "xl/styles.xml": STYLES,
    ...(strings.size ? { "xl/sharedStrings.xml": strings.xml() } : {}),
    ...parts,
  })
}

export const NEW_PARAGRAPH_STYLES = ["Title", "Heading1", "Heading2", "Heading3", "Normal", "ListBullet"] as const
export type NewParagraphStyle = (typeof NEW_PARAGRAPH_STYLES)[number]

export interface NewRun {
  /** A tab is `\t`, a line break `\n`. */
  readonly text: string
  readonly bold?: boolean
  readonly italic?: boolean
}

export type NewParagraph = (
  | { readonly text: string; readonly bold?: boolean; readonly italic?: boolean }
  | { readonly runs: readonly NewRun[] }
) & {
  /** `Normal` when absent. */
  readonly style?: NewParagraphStyle
}

export interface NewTable {
  /** Rows of cell texts; a shorter row is filled with empty cells. */
  readonly table: readonly (readonly string[])[]
  /** The first row in bold, repeated at the top of each page. */
  readonly header?: boolean
}

export interface CreateDocxOptions {
  /** The body in order: paragraphs and tables. */
  readonly paragraphs: readonly (NewParagraph | NewTable)[]
}

const heading = (level: number, size: number, before: number) =>
  `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/>` +
  '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>' +
  `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="80"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
  `<w:rPr><w:b/><w:bCs/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`

// Word's built-in names ("heading 1", "List Bullet"), so Word, LibreOffice and mammoth know the styles as their own.
const WORD_STYLES =
  `<w:styles xmlns:w="${WORD_NS}">` +
  "<w:docDefaults><w:rPrDefault><w:rPr>" +
  '<w:rFonts w:ascii="Calibri" w:eastAsia="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>' +
  '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
  "</w:docDefaults>" +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>' +
  '<w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:spacing w:after="80"/></w:pPr>' +
  '<w:rPr><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>' +
  heading(1, 40, 360) +
  heading(2, 32, 160) +
  heading(3, 28, 160) +
  '<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/>' +
  '<w:uiPriority w:val="99"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:contextualSpacing/></w:pPr></w:style>' +
  "</w:styles>"

const NUMBERING =
  `<w:numbering xmlns:w="${WORD_NS}"><w:abstractNum w:abstractNumId="0">` +
  '<w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/>' +
  '<w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>' +
  '</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>'

const runXml = ({ text, bold, italic }: NewRun) => {
  const content = text
    .replace(/\r\n?/gu, "\n")
    .split(/(\n|\t)/u)
    .filter((piece) => piece !== "")
    .map((piece) =>
      piece === "\n" ? "<w:br/>" : piece === "\t" ? "<w:tab/>" : `<w:t xml:space="preserve">${escapeText(piece)}</w:t>`,
    )
    .join("")
  if (!content) return ""
  const properties = (bold ? "<w:b/><w:bCs/>" : "") + (italic ? "<w:i/><w:iCs/>" : "")
  return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ""}${content}</w:r>`
}

const paragraphXml = (paragraph: NewParagraph) => {
  const { style = "Normal" } = paragraph
  if (!NEW_PARAGRAPH_STYLES.includes(style))
    throw refuse(`${style} is not a style here; use ${NEW_PARAGRAPH_STYLES.join(", ")}`, "office.invalid-value")
  // The list's numbering is on the paragraph too: a reader that ignores a style's numbering still sees a bullet.
  const properties =
    style === "Normal"
      ? ""
      : `<w:pPr><w:pStyle w:val="${style}"/>${style === "ListBullet" ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : ""}</w:pPr>`
  const runs = "runs" in paragraph ? paragraph.runs : [paragraph]
  return `<w:p>${properties}${runs.map(runXml).join("")}</w:p>`
}

// The text width of the A4 page between its margins, in twentieths of a point.
const TEXT_WIDTH = 11_906 - 2 * 1_417
const BORDER = 'w:val="single" w:sz="4" w:space="0" w:color="auto"'

const tableXml = ({ table, header = false }: NewTable) => {
  const columns = table.reduce((widest, row) => Math.max(widest, row.length), 1)
  if (columns > MAX_TABLE_COLUMNS) throw refuse("a Word table has at most 63 columns", "office.invalid-value")
  const width = Math.floor(TEXT_WIDTH / columns)
  const borders = ["top", "left", "bottom", "right", "insideH", "insideV"].map((side) => `<w:${side} ${BORDER}/>`)
  const rows = (table.length ? table : [[]]).map((cells, down) => {
    const bold = header && down === 0
    const tcs = Array.from({ length: columns }, (_, across) => {
      const text = cells[across] ?? ""
      return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr><w:p>${runXml({ text, bold })}</w:p></w:tc>`
    })
    return `<w:tr>${bold ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${tcs.join("")}</w:tr>`
  })
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${width * columns}" w:type="dxa"/><w:tblBorders>${borders.join("")}</w:tblBorders>` +
    `</w:tblPr><w:tblGrid>${`<w:gridCol w:w="${width}"/>`.repeat(columns)}</w:tblGrid>` +
    `${rows.join("")}</w:tbl>`
  )
}

// Word merges two tables that touch and needs a paragraph to end the body, so a table is never last or next to another.
const bodyXml = (blocks: readonly (NewParagraph | NewTable)[]) => {
  let previousTable = false
  const parts = blocks.flatMap((block) => {
    const isTable = "table" in block
    const xml = isTable ? tableXml(block) : paragraphXml(block)
    const between = isTable && previousTable ? ["<w:p/>"] : []
    previousTable = isTable
    return [...between, xml]
  })
  if (!parts.length || previousTable) parts.push("<w:p/>")
  return parts.join("")
}

/**
 * A new Word document with these paragraphs and tables, on A4 with 2.5 cm margins, and a styles part that defines
 * Title, Heading1 to Heading3, Normal and ListBullet (a bullet list). No document properties, so the same input gives
 * the same bytes.
 */
export const createDocx = (options: CreateDocxOptions): Uint8Array => {
  const body = bodyXml(options.paragraphs)
  const section =
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417" ' +
    'w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
  return packed({
    "[Content_Types].xml": contentTypes({
      "word/document.xml": "wordprocessingml.document.main+xml",
      "word/styles.xml": "wordprocessingml.styles+xml",
      "word/numbering.xml": "wordprocessingml.numbering+xml",
    }),
    "_rels/.rels": relationships([["officeDocument", "word/document.xml"]]),
    "word/document.xml": `<w:document xmlns:w="${WORD_NS}" xmlns:r="${OFFICE_REL}"><w:body>${body}${section}</w:body></w:document>`,
    "word/_rels/document.xml.rels": relationships([
      ["styles", "styles.xml"],
      ["numbering", "numbering.xml"],
    ]),
    "word/styles.xml": WORD_STYLES,
    "word/numbering.xml": NUMBERING,
  })
}
