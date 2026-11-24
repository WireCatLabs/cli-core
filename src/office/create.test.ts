import { createHash } from "node:crypto"
import { strFromU8, unzipSync } from "fflate"
import mammoth from "mammoth"
import { afterEach, describe, expect, it } from "vitest"
import { readSpreadsheet } from "../attachments/documents.js"
import {
  createDocx,
  createXlsx,
  editDocxParagraphs,
  editXlsxCells,
  readDocxParagraphs,
  readXlsxCells,
} from "./index.js"

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const partOf = (bytes: Uint8Array, path: string) => strFromU8(unzipSync(bytes)[path] as Uint8Array)

const zone = process.env.TZ
afterEach(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
})

describe("createXlsx", () => {
  const budget = () =>
    createXlsx({
      sheets: [
        {
          name: "Budget",
          rows: [
            ["Item", "Cost", "Paid"],
            ["Rent", 950, true],
            ["=SUM(B2)", null, false],
            [],
            ["Rent"],
            [
              { value: "=1+1", bold: true },
              { formula: "=SUM(B2:B3)" },
              { formula: 'IF(Data!A1<5,"low","high")', bold: true },
            ],
          ],
        },
        { name: "Empty", rows: [] },
        { name: "Data", rows: [[{ value: 3 }]], header: true },
      ],
      boldHeader: true,
    })

  it("writes typed cells that its own reader and the shared spreadsheet reader read back", async () => {
    const bytes = budget()
    const [sheet, empty] = await readXlsxCells(bytes)
    expect(sheet?.name).toBe("Budget")
    expect(sheet?.cells.map(({ address, value, type }) => [address, value, type])).toEqual([
      ["A1", "Item", "string"],
      ["B1", "Cost", "string"],
      ["C1", "Paid", "string"],
      ["A2", "Rent", "string"],
      ["B2", 950, "number"],
      ["C2", true, "boolean"],
      ["A3", "=SUM(B2)", "string"],
      ["C3", false, "boolean"],
      ["A5", "Rent", "string"],
      ["A6", "=1+1", "string"],
      ["B6", null, "empty"],
      ["C6", null, "empty"],
    ])
    expect(sheet?.cells.filter((cell) => cell.formula !== undefined).map((cell) => cell.formula)).toEqual([
      "SUM(B2:B3)",
      'IF(Data!A1<5,"low","high")',
    ])
    expect(empty).toEqual({ name: "Empty", cells: [] })
    const shared = await readSpreadsheet(bytes, "xlsx")
    expect(shared.map((one) => one.name)).toEqual(["Budget", "Empty", "Data"])
    expect(JSON.stringify(shared[0])).toContain("950")
  })

  it("makes the header row and the bold cells bold through the second cell format, and shares a repeated text", async () => {
    const bytes = budget()
    const [sheet, , data] = await readXlsxCells(bytes)
    expect(sheet?.cells.filter((cell) => cell.style === 1).map((cell) => cell.address)).toEqual([
      "A1",
      "B1",
      "C1",
      "A6",
      "C6",
    ])
    expect(data?.cells).toMatchObject([{ address: "A1", value: 3, style: 1 }])
    expect(partOf(bytes, "xl/styles.xml")).toContain('<font><b/><sz val="11"/>')
    expect(partOf(bytes, "xl/sharedStrings.xml")).toContain('count="7" uniqueCount="6"')
    expect(partOf(bytes, "xl/worksheets/sheet1.xml")).toContain('<dimension ref="A1:C6"/>')
  })

  it("writes a formula without a cached result, escaped, and asks for a full calculation on open", () => {
    const bytes = budget()
    expect(partOf(bytes, "xl/worksheets/sheet1.xml")).toContain(
      '<c r="C6" s="1"><f>IF(Data!A1&lt;5,"low","high")</f></c>',
    )
    expect(partOf(bytes, "xl/workbook.xml")).toContain('</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/>')
    expect(partOf(createXlsx({ sheets: [{ name: "N", rows: [[1]] }] }), "xl/workbook.xml")).not.toContain("calcPr")
  })

  it("gives the same bytes for the same rows in any time zone, and the editor changes the new file", async () => {
    process.env.TZ = "Pacific/Kiritimati"
    const east = budget()
    process.env.TZ = "America/Los_Angeles"
    expect(sha256(budget())).toBe(sha256(east))
    const { bytes } = await editXlsxCells(east, [{ sheet: "Budget", cell: "B2", value: 1000 }])
    const [sheet] = await readXlsxCells(bytes, { range: "B2" })
    expect(sheet?.cells[0]?.value).toBe(1000)
  })

  it("leaves the shared strings part out when no cell holds text", async () => {
    const bytes = createXlsx({ sheets: [{ name: "N", rows: [[1, 2]] }] })
    expect(Object.keys(unzipSync(bytes))).not.toContain("xl/sharedStrings.xml")
    const [sheet] = await readXlsxCells(bytes)
    expect(sheet?.cells.map((cell) => cell.value)).toEqual([1, 2])
  })

  it("refuses a sheet name Excel refuses, a repeated one, an infinite number and a control character", () => {
    for (const name of ["", "a".repeat(32), "a/b", "'quoted'", "x[1]"])
      expect(() => createXlsx({ sheets: [{ name, rows: [] }] })).toThrow(
        expect.objectContaining({ details: { reason: "office.invalid-sheet-name" } }),
      )
    expect(() =>
      createXlsx({
        sheets: [
          { name: "Data", rows: [] },
          { name: "data", rows: [] },
        ],
      }),
    ).toThrow(/two sheets/)
    expect(() => createXlsx({ sheets: [] })).toThrow(/at least one sheet/)
    expect(() => createXlsx({ sheets: [{ name: "S", rows: [[Number.NaN]] }] })).toThrow(
      expect.objectContaining({ details: { reason: "office.invalid-value" } }),
    )
    expect(() => createXlsx({ sheets: [{ name: "S", rows: [["a\u0001b"]] }] })).toThrow(/control character/)
    for (const formula of ["=", " ", "A".repeat(8193)])
      expect(() => createXlsx({ sheets: [{ name: "S", rows: [[{ formula }]] }] })).toThrow(
        expect.objectContaining({ details: { reason: "office.invalid-value" } }),
      )
  })
})

describe("createDocx", () => {
  const report = () =>
    createDocx({
      paragraphs: [
        { text: "Quarterly report", style: "Title" },
        { text: "Revenue", style: "Heading1" },
        { text: "Grew 12%.\tSee the table.\nNext line & more" },
        { text: "Costs", style: "Heading2" },
        { text: "Details", style: "Heading3" },
        { text: "Rent", style: "ListBullet" },
        { text: "Salaries", style: "ListBullet" },
        { text: "", style: "Normal" },
        { runs: [{ text: "Revenue " }, { text: "grew", bold: true }, { text: " 12%", italic: true }] },
        { text: "All of it", bold: true, italic: true },
        { table: [["Item", "Cost"], ["Rent", "950"], ["Food"]], header: true },
        { table: [["Next table"]] },
      ],
    })

  it("writes paragraphs whose text and named styles the paragraph reader reads back", async () => {
    const paragraphs = (await readDocxParagraphs(report())).slice(0, 8)
    expect(paragraphs.map(({ text, styleId, style, editable }) => ({ text, styleId, style, editable }))).toEqual([
      { text: "Quarterly report", styleId: "Title", style: "Title", editable: true },
      { text: "Revenue", styleId: "Heading1", style: "heading 1", editable: true },
      { text: "Grew 12%.\tSee the table.\nNext line & more", styleId: undefined, style: undefined, editable: true },
      { text: "Costs", styleId: "Heading2", style: "heading 2", editable: true },
      { text: "Details", styleId: "Heading3", style: "heading 3", editable: true },
      { text: "Rent", styleId: "ListBullet", style: "List Bullet", editable: true },
      { text: "Salaries", styleId: "ListBullet", style: "List Bullet", editable: true },
      { text: "", styleId: undefined, style: undefined, editable: true },
    ])
  })

  it("writes bold and italic runs, and tables apart from each other with an empty paragraph to end the body", async () => {
    const bytes = report()
    const paragraphs = (await readDocxParagraphs(bytes)).slice(8)
    expect(paragraphs.map(({ text, location, mixedFormatting }) => [text, location, mixedFormatting])).toEqual([
      ["Revenue grew 12%", "body", true],
      ["All of it", "body", false],
      ["Item", "table", false],
      ["Cost", "table", false],
      ["Rent", "table", false],
      ["950", "table", false],
      ["Food", "table", false],
      ["", "table", false],
      ["", "body", false],
      ["Next table", "table", false],
      ["", "body", false],
    ])
    const document = partOf(bytes, "word/document.xml")
    expect(document).toContain('<w:r><w:rPr><w:b/><w:bCs/><w:i/><w:iCs/></w:rPr><w:t xml:space="preserve">All of it')
    expect(document).toContain("<w:tr><w:trPr><w:tblHeader/></w:trPr>")
    expect(document).toContain('<w:tblGrid><w:gridCol w:w="4536"/><w:gridCol w:w="4536"/></w:tblGrid>')
    expect(document).toMatch(/<\/w:tbl><w:p\/><w:sectPr>/u)
    expect(() => createDocx({ paragraphs: [{ table: [Array.from({ length: 64 }, () => "x")] }] })).toThrow(
      expect.objectContaining({ details: { reason: "office.invalid-value" } }),
    )
  })

  it("reads in mammoth as headings, a paragraph and a bullet list", async () => {
    const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(report()) })
    expect(value).toContain("<h1>Revenue</h1>")
    expect(value).toContain("<h2>Costs</h2>")
    expect(value).toContain("<h3>Details</h3>")
    expect(value).toContain("<ul><li>Rent</li><li>Salaries</li></ul>")
    expect(value).toContain("Next line &amp; more")
    expect(value).toContain("<p>Revenue <strong>grew</strong><em> 12%</em></p>")
    expect(value).toContain("<table><thead><tr><th><p><strong>Item</strong></p></th>")
    expect(value).toContain("<tr><td><p>Food</p></td><td></td></tr></tbody></table>")
  })

  it("gives the same bytes for the same paragraphs in any time zone, and the editor changes the new file", async () => {
    process.env.TZ = "Pacific/Kiritimati"
    const east = report()
    process.env.TZ = "America/Los_Angeles"
    expect(sha256(report())).toBe(sha256(east))
    const { bytes } = await editDocxParagraphs(east, [
      { index: 1, text: "Income" },
      { insertAfter: 6, text: "Travel" },
    ])
    const paragraphs = await readDocxParagraphs(bytes)
    expect(paragraphs[1]).toMatchObject({ text: "Income", style: "heading 1" })
    expect(paragraphs[7]).toMatchObject({ text: "Travel", style: "List Bullet" })
  })

  it("writes one empty paragraph for no paragraphs, and refuses a control character or an unknown style", async () => {
    expect(await readDocxParagraphs(createDocx({ paragraphs: [] }))).toMatchObject([{ index: 0, text: "" }])
    expect(() => createDocx({ paragraphs: [{ text: "a\u0007" }] })).toThrow(/control character/)
    expect(() => createDocx({ paragraphs: [{ text: "a", style: "Heading9" as "Normal" }] })).toThrow(
      expect.objectContaining({ details: { reason: "office.invalid-value" } }),
    )
  })
})
