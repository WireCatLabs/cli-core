import { readFileSync } from "node:fs"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { readSpreadsheet } from "../attachments/documents.js"
import { editXlsxCells, readXlsxCells } from "./index.js"
import { rawEntry } from "./zip.js"

const budget = new Uint8Array(readFileSync(new URL("../testing/fixtures/budget.xlsx", import.meta.url)))

const entriesOf = (bytes: Uint8Array) => Object.keys(unzipSync(bytes))
const partOf = (bytes: Uint8Array, path: string) => strFromU8(unzipSync(bytes)[path] as Uint8Array)
const withParts = (bytes: Uint8Array, parts: Record<string, string | null>) => {
  const files = unzipSync(bytes)
  for (const [path, text] of Object.entries(parts)) {
    if (text === null) delete files[path]
    else files[path] = strToU8(text)
  }
  return zipSync(files, { level: 6, mtime: new Date(Date.UTC(2026, 0, 1)) })
}
const cell = async (bytes: Uint8Array, address: string, sheet = "Synthetic Budget") =>
  (await readXlsxCells(bytes, { sheet })).at(0)?.cells.find((entry) => entry.address === address)

const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
/** A workbook from another writer: every element under the `x:` prefix, no shared strings part. */
const prefixed = () =>
  zipSync(
    {
      "[Content_Types].xml": strToU8(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
      ),
      "_rels/.rels": strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ),
      "xl/workbook.xml": strToU8(
        `<x:workbook xmlns:x="${SHEET_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets><x:sheet name="Data" sheetId="1" r:id="s1"/></x:sheets><x:definedNames><x:definedName name="Total">Data!$B$1</x:definedName></x:definedNames><x:extLst/></x:workbook>`,
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="s1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      "xl/worksheets/sheet1.xml": strToU8(
        `<x:worksheet xmlns:x="${SHEET_NS}"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>old</x:t></x:is></x:c><x:c r="B1" t="b"><x:v>1</x:v></x:c><x:c r="C1"><x:f t="shared" ref="C1:C2" si="0">A1&amp;"!"</x:f><x:v>old!</x:v></x:c></x:row><x:row r="2"><x:c r="C2"><x:f t="shared" si="0"/><x:v>!</x:v></x:c></x:row></x:sheetData></x:worksheet>`,
      ),
    },
    { level: 6, mtime: new Date(Date.UTC(2026, 0, 1)) },
  )

describe("readXlsxCells", () => {
  it("**lists each stored cell** with its address, value, type, formula and format index", async () => {
    const [sheet] = await readXlsxCells(budget)
    expect(sheet?.name).toBe("Synthetic Budget")
    expect(sheet?.cells.find((entry) => entry.address === "A2")).toEqual({
      address: "A2",
      row: 2,
      column: 1,
      value: "Rent",
      type: "string",
      style: 0,
    })
    expect(sheet?.cells.find((entry) => entry.address === "D2")).toMatchObject({
      value: 0.25,
      type: "number",
      style: 2,
    })
    expect(sheet?.cells.find((entry) => entry.address === "B4")).toMatchObject({ value: 1200.3, formula: "B2+B3" })
  })

  it("**narrows to a range** and refuses a sheet the workbook does not have", async () => {
    const [sheet] = await readXlsxCells(budget, { range: "B2:C3" })
    expect(sheet?.cells.map((entry) => entry.address)).toEqual(["B2", "C2", "B3"])
    await expect(readXlsxCells(budget, { sheet: "Nope" })).rejects.toThrow(/no sheet "Nope"; it has "Synthetic Budget"/)
    await expect(readXlsxCells(budget, { range: "A0" })).rejects.toThrow(/not a cell address/)
  })
})

describe("editXlsxCells", () => {
  it("**replaces a shared-string cell** with a new shared string and copies every other entry byte for byte", async () => {
    const value = "Rent & <food> 🐟  "
    const result = await editXlsxCells(budget, [{ sheet: "Synthetic Budget", cell: "A2", value }])
    expect(await cell(result.bytes, "A2")).toMatchObject({ value, type: "string", style: 0 })
    expect(await cell(result.bytes, "A3")).toMatchObject({ value: "Heron food" })
    expect(result.changed).toEqual([
      { sheet: "Synthetic Budget", cell: "A2", before: "Rent", after: value, created: false },
    ])
    const strings = partOf(result.bytes, "xl/sharedStrings.xml")
    expect(strings).toContain('<t xml:space="preserve">Rent &amp; &lt;food&gt; 🐟  </t>')
    expect(strings).toContain("<t>Rent</t>")
    expect(partOf(result.bytes, "xl/workbook.xml")).toContain('<calcPr calcId="171027" fullCalcOnLoad="1"/>')
    const rewritten = ["xl/worksheets/sheet1.xml", "xl/sharedStrings.xml", "xl/workbook.xml"]
    expect(entriesOf(result.bytes)).toEqual(entriesOf(budget))
    for (const name of entriesOf(budget).filter((entry) => !rewritten.includes(entry)))
      expect(rawEntry(result.bytes, name), name).toEqual(rawEntry(budget, name))
    expect((await readSpreadsheet(result.bytes, "xlsx"))[0]?.cells).toContainEqual({ row: 2, column: 1, value })
  })

  it("**writes a number, keeping the cell's format**, and the same edit gives the same bytes", async () => {
    const edit = [{ sheet: "Synthetic Budget", cell: "D2", value: 0.5 }]
    const first = await editXlsxCells(budget, edit)
    expect(await cell(first.bytes, "D2")).toMatchObject({ value: 0.5, type: "number", style: 2 })
    expect(partOf(first.bytes, "xl/worksheets/sheet1.xml")).toContain('<c r="D2" s="2"><v>0.5</v></c>')
    expect((await editXlsxCells(budget, edit)).bytes).toEqual(first.bytes)
  })

  it("**adds a cell in a new row and in an existing row**, in address order, and grows the dimension", async () => {
    const result = await editXlsxCells(budget, [
      { sheet: "Synthetic Budget", cell: "F7", value: true },
      { sheet: "Synthetic Budget", cell: "C3", value: "between" },
      { sheet: "Synthetic Budget", cell: "A4", value: "first in row" },
      { sheet: "Synthetic Budget", cell: "B6", value: 7 },
    ])
    const sheet = partOf(result.bytes, "xl/worksheets/sheet1.xml")
    expect(sheet).toContain('<dimension ref="A1:F7"/>')
    expect(sheet).toMatch(/<c r="B3"><v>[^<]+<\/v><\/c><c r="C3" t="s"><v>\d+<\/v><\/c><\/row>/)
    expect(sheet).toMatch(/<row r="4"[^>]*><c r="A4" t="s"><v>\d+<\/v><\/c><c r="B4">/)
    expect(sheet).toContain(
      '</row><row r="6"><c r="B6"><v>7</v></c></row><row r="7"><c r="F7" t="b"><v>1</v></c></row></sheetData>',
    )
    expect(await cell(result.bytes, "F7")).toMatchObject({ value: true, type: "boolean" })
    expect(result.changed.filter((entry) => entry.created)).toHaveLength(4)
  })

  it("**refuses a formula cell** unless told to overwrite it, and then drops the calculation chain", async () => {
    const edit = [{ sheet: "Synthetic Budget", cell: "B4", value: 5 }]
    await expect(editXlsxCells(budget, edit)).rejects.toMatchObject({
      code: "validation_error",
      details: { reason: "office.formula_cell" },
      message: expect.stringContaining("=B2+B3"),
    })
    const chained = withParts(budget, {
      "xl/calcChain.xml": `<calcChain xmlns="${SHEET_NS}"><c r="B4" i="1"/></calcChain>`,
      "xl/_rels/workbook.xml.rels": partOf(budget, "xl/_rels/workbook.xml.rels").replace(
        "</Relationships>",
        '<Relationship Id="rIdChain" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>',
      ),
      "[Content_Types].xml": partOf(budget, "[Content_Types].xml").replace(
        "</Types>",
        '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>',
      ),
    })
    const result = await editXlsxCells(chained, edit, { overwriteFormulas: true })
    expect(await cell(result.bytes, "B4")).toEqual({
      address: "B4",
      row: 4,
      column: 2,
      value: 5,
      type: "number",
      style: 0,
    })
    expect(result.calcChainDropped).toBe(true)
    expect(entriesOf(result.bytes)).not.toContain("xl/calcChain.xml")
    expect(partOf(result.bytes, "xl/_rels/workbook.xml.rels")).not.toContain("calcChain")
    expect(partOf(result.bytes, "[Content_Types].xml")).not.toContain("calcChain")
  })

  it("**writes inline strings under the file's own prefix** when there is no shared strings part", async () => {
    const result = await editXlsxCells(
      prefixed(),
      [
        { sheet: "Data", cell: "A1", value: "new" },
        { sheet: "Data", cell: "B1", value: null },
        { sheet: "Data", cell: "C2", value: "plain" },
      ],
      { overwriteFormulas: true },
    )
    const sheet = partOf(result.bytes, "xl/worksheets/sheet1.xml")
    expect(sheet).toContain(
      '<x:c r="A1" t="inlineStr"><x:is><x:t xml:space="preserve">new</x:t></x:is></x:c><x:c r="B1"></x:c>',
    )
    expect(sheet).toContain('<x:c r="C2" t="inlineStr"><x:is><x:t xml:space="preserve">plain</x:t></x:is></x:c>')
    expect(partOf(result.bytes, "xl/workbook.xml")).toContain(
      '</x:definedNames><x:calcPr fullCalcOnLoad="1"/><x:extLst/>',
    )
    expect((await readXlsxCells(result.bytes))[0]?.cells.find((entry) => entry.address === "B1")).toMatchObject({
      value: null,
      type: "empty",
    })
  })

  it("**refuses a formula other cells share**, a cell edited twice and a character XML cannot hold", async () => {
    await expect(
      editXlsxCells(prefixed(), [{ sheet: "Data", cell: "C1", value: 1 }], { overwriteFormulas: true }),
    ).rejects.toMatchObject({ details: { reason: "office.shared_formula" } })
    await expect(
      editXlsxCells(budget, [
        { sheet: "Synthetic Budget", cell: "a2", value: 1 },
        { sheet: "Synthetic Budget", cell: "A2", value: 2 },
      ]),
    ).rejects.toMatchObject({ details: { reason: "office.duplicate_edit" } })
    await expect(
      editXlsxCells(budget, [{ sheet: "Synthetic Budget", cell: "A2", value: "bell\u0007" }]),
    ).rejects.toThrow(/control character/)
    await expect(editXlsxCells(budget, [{ sheet: "Synthetic Budget", cell: "A2", value: Number.NaN }])).rejects.toThrow(
      /finite/,
    )
  })
})
