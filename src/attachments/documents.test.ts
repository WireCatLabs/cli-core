import { readFileSync } from "node:fs"
import { strToU8, zipSync } from "fflate"
import { describe, expect, it, vi } from "vitest"
import { zip } from "../testing/files.js"
import {
  bookEntries,
  odfEntries,
  officeFixture,
  presentationEntries,
  sheetEntries,
  slideEntries,
} from "../testing/office-files.js"
import { readContainer } from "./container.js"
import { documentExtractor, readSpreadsheet } from "./documents.js"
import { extractText, importEngine } from "./extract.js"

const hint = (kind: string) => ({ kind: "file", name: `fixture.${kind}`, mime: null, path: `/fixture.${kind}` })
const read = (kind: string, entries: Record<string, string>) => extractText(zip(entries), hint(kind), importEngine)
const textOf = async (kind: string, entries: Record<string, string>) => {
  const result = await read(kind, entries)
  expect(result.status).toBe("extracted")
  return result.status === "extracted" ? result.text : ""
}

describe("digital document text", () => {
  it.each(["odt", "ods", "odp", "xlsx", "pptx", "epub"] as const)(
    "reads %s locally from an actual ZIP container",
    async (kind) => {
      const noEngine = vi.fn(() => {
        throw new Error("no optional engine or API needed")
      })
      expect(await extractText(officeFixture(kind), hint(kind), noEngine)).toMatchObject({
        status: "extracted",
        extractor: documentExtractor(kind),
      })
      expect(noEngine).not.toHaveBeenCalled()
    },
  )
  it("preserves ODT paragraph order, inline text and explicit spaces/tabs", async () => {
    expect(await textOf("odt", odfEntries("odt"))).toBe("Heading\nreaderneedle Привет   world\t42\nnext")
  })
  it("expands meaningful ODS repeats and skips empty ranges, row by row", async () => {
    const text = await textOf("ods", odfEntries("ods"))
    expect(text).toBe(
      "# Budget\nRow 1: A: cellneedle; B: cellneedle; C: 42\nRow 2: A: cellneedle; B: cellneedle; C: 42",
    )
  })
  it("uses workbook order, rich/shared and inline strings, a header row and cached values", async () => {
    const text = await textOf("xlsx", sheetEntries())
    expect(text).toBe("# First\nRow 2: C: 12; D: =1+1\n\n# Second\nRow 7: B: sharedneedle")
  })
  it("returns an XLSX workbook's cells per worksheet", async () => {
    const sheets = await readSpreadsheet(zip(sheetEntries()), "xlsx")
    expect(sheets.map((sheet) => sheet.name)).toEqual(["First", "Second"])
    expect(sheets[0]?.cells).toContainEqual({ row: 2, column: 3, value: "12" })
    expect(sheets[1]?.cells).toContainEqual({ row: 7, column: 2, value: "sharedneedle" })
    await expect(readSpreadsheet(zip(odfEntries("odt")), "xlsx")).rejects.toMatchObject({
      code: "validation_error",
    })
  })
  it("reads ODP slides in order", async () => {
    expect(await textOf("odp", presentationEntries())).toBe("[Slide 1]\nFirst slideneedle\n\n\n[Slide 2]\nLater слайд")
  })
  it("uses presentation order, not archive order", async () => {
    const text = await textOf("pptx", slideEntries())
    expect(text).toBe("[Slide 1]\nFirst slideneedle\n\n\n[Slide 2]\nLater slide")
  })
  it("uses EPUB spine order and excludes scripts, styles and head metadata", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"))
    try {
      const text = await textOf("epub", bookEntries())
      expect(text.indexOf("First bookneedle")).toBeLessThan(text.indexOf("Later book chapter"))
      expect(text).toContain("Привет")
      expect(text).not.toMatch(/hidden|execute/)
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      fetcher.mockRestore()
    }
  })
  it("supports DEFLATE as well as stored ZIP entries", async () => {
    const bytes = zipSync(
      Object.fromEntries(Object.entries(odfEntries("odt")).map(([name, value]) => [name, strToU8(value)])),
    )
    expect(await extractText(bytes, hint("odt"), importEngine)).toMatchObject({ status: "extracted" })
  })
  it("rejects missing parts, wrong format, bad XML and absent shared strings without partial text", async () => {
    const sheet = sheetEntries()
    delete sheet["xl/worksheets/one.xml"]
    expect(await read("xlsx", sheet)).toMatchObject({ status: "unreadable", error: "invalid_document" })
    expect(await read("ods", odfEntries("odt"))).toMatchObject({ status: "unreadable" })
    expect(await read("odt", { ...odfEntries("odt"), "content.xml": "<broken>" })).toMatchObject({
      status: "unreadable",
    })
    const missing = sheetEntries()
    missing["xl/sharedStrings.xml"] = missing["xl/sharedStrings.xml"]?.replace("shared", "different") ?? ""
    missing["xl/worksheets/one.xml"] = missing["xl/worksheets/one.xml"]?.replace("<v>0</v>", "<v>9</v>") ?? ""
    expect(await read("xlsx", missing)).toMatchObject({ status: "unreadable" })
  })
  it("leaves empty documents for the agent without indexing synthetic headings", async () => {
    expect(await read("odt", odfEntries("odt", ""))).toMatchObject({ status: "needs-agent" })
    const sheet = sheetEntries()
    sheet["xl/worksheets/one.xml"] = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>`
    sheet["xl/worksheets/two.xml"] = sheet["xl/worksheets/one.xml"]
    expect(await read("xlsx", sheet)).toMatchObject({ status: "needs-agent" })
  })
  it("rejects archive traversal, encrypted parts, DTD entities and external essential relationships", async () => {
    expect(await read("odt", { ...odfEntries("odt"), "../escape.txt": "escape" })).toMatchObject({
      status: "unreadable",
    })
    const encrypted = odfEntries("odt")
    encrypted["META-INF/manifest.xml"] =
      '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:encryption-data/></manifest:manifest>'
    expect(await read("odt", encrypted)).toMatchObject({ status: "unreadable" })
    expect(
      await read("odt", {
        ...odfEntries("odt"),
        "content.xml": '<!DOCTYPE x [<!ENTITY content SYSTEM "https://example.test/secret">]><x>&content;</x>',
      }),
    ).toMatchObject({ status: "unreadable" })
    const external = sheetEntries()
    external["xl/_rels/workbook.xml.rels"] =
      external["xl/_rels/workbook.xml.rels"]?.replace(
        'Target="worksheets/one.xml"',
        'TargetMode="External" Target="https://example.test/sheet.xml"',
      ) ?? ""
    expect(await read("xlsx", external)).toMatchObject({ status: "unreadable" })
  })
  it("bounds XML depth, repeated text expansion and archive entry count", async () => {
    expect(await read("odt", odfEntries("odt", '<text:p><text:s text:c="2000001"/></text:p>'))).toMatchObject({
      status: "too-large",
    })
    expect(
      await read("odt", { ...odfEntries("odt"), "content.xml": "<x>".repeat(130) + "</x>".repeat(130) }),
    ).toMatchObject({ status: "too-large" })
    expect(
      await read("odt", Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`${i}.txt`, "x"]))),
    ).toMatchObject({ status: "too-large" })
  })
  it("validates checksums and actual expanded size even if metadata lies", async () => {
    const bytes = zip(odfEntries("odt"))
    const damaged = bytes.slice()
    const payload = Buffer.from(damaged).indexOf("readerneedle")
    if (payload < 0) throw new Error("fixture text missing")
    damaged[payload] = 65
    expect(await extractText(damaged, hint("odt"), importEngine)).toMatchObject({ status: "unreadable" })
    const bomb = zipSync({ "content.xml": strToU8("x".repeat(11 * 1024 * 1024)) })
    const view = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength)
    view.setUint32(22, 1, true)
    for (let i = 0; i < bomb.length - 46; i++)
      if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 1, true)
    expect(await extractText(bomb, hint("odt"), importEngine)).toMatchObject({ status: "too-large" })
  })
  it("supports cancellation before and during streaming, without a partial result", async () => {
    const aborted = AbortSignal.abort()
    await expect(readContainer(officeFixture("odt"), aborted)).rejects.toMatchObject({ code: "cancelled" })
    const controller = new AbortController()
    const pending = readContainer(zip({ ...odfEntries("odt"), "large.txt": "x".repeat(100000) }), controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: "cancelled" })
  })
  it("preserves soft line breaks and tabs in presentation paragraphs", async () => {
    const entries = slideEntries()
    entries["ppt/slides/two.xml"] =
      entries["ppt/slides/two.xml"]?.replace(
        "First slideneedle</a:t></a:r>",
        "First</a:t></a:r><a:br/><a:r><a:t>slideneedle</a:t></a:r><a:tab/>",
      ) ?? ""
    expect(await textOf("pptx", entries)).toContain("First\nslideneedle\t")
  })
  it("accepts strict OOXML namespaces and MIME-based format discovery", async () => {
    const entries = Object.fromEntries(
      Object.entries(sheetEntries()).map(([name, value]) => [
        name,
        value
          .replaceAll(
            "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
            "http://purl.oclc.org/ooxml/spreadsheetml/main",
          )
          .replaceAll(
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
            "http://purl.oclc.org/ooxml/officeDocument/relationships",
          ),
      ]),
    )
    expect(
      await extractText(
        zip(entries),
        { ...hint("upload"), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        importEngine,
      ),
    ).toMatchObject({ status: "extracted" })
  })
  it("rejects encrypted ZIP headers, duplicate parts and incomplete containers", async () => {
    const encrypted = officeFixture("odt").slice(),
      view = new DataView(encrypted.buffer)
    view.setUint16(6, 1, true)
    for (let index = 0; index < encrypted.length - 46; index++)
      if (view.getUint32(index, true) === 0x02014b50) {
        view.setUint16(index + 8, 1, true)
        break
      }
    expect(await extractText(encrypted, hint("odt"), importEngine)).toMatchObject({ status: "unreadable" })
    expect(await extractText(officeFixture("odt").subarray(0, 30), hint("odt"), importEngine)).toMatchObject({
      status: "unreadable",
    })
    const duplicate = zip({ "aa.xml": "<x/>", "bb.xml": "<x/>" })
    const changed = Buffer.from(duplicate).toString("latin1").replaceAll("bb.xml", "aa.xml")
    expect(await extractText(new Uint8Array(Buffer.from(changed, "latin1")), hint("odt"), importEngine)).toMatchObject({
      status: "unreadable",
    })
  })
  it("does not strip a doctype-like string out of chapter data", async () => {
    const entries = bookEntries()
    entries["Book/two.xhtml"] =
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><![CDATA[<!DOCTYPE html>]]></body></html>'
    expect(await read("epub", entries)).toMatchObject({ status: "unreadable" })
  })
  it("keeps generic archives and binary legacy Office formats unsupported", async () => {
    for (const kind of ["zip", "doc", "xls", "ppt", "rtf"])
      expect(await extractText(zip(odfEntries("odt")), hint(kind), importEngine)).toMatchObject({
        status: "unsupported",
      })
  })
})

describe("legacy and markup text", () => {
  const bytes = (text: string) => new TextEncoder().encode(text)
  const textFrom = async (data: Uint8Array, kind: string) => {
    const result = await extractText(data, hint(kind), importEngine)
    expect(result.status).toBe("extracted")
    return result.status === "extracted" ? result : undefined
  }

  it("**reads a Word 97–2003 .doc**", async () => {
    const doc = new Uint8Array(readFileSync(new URL("../testing/fixtures/legacy.doc", import.meta.url)))
    const result = await textFrom(doc, "doc")
    expect(result?.text).toContain("The heron count rose to 42 in October. Цапли вернулись.")
    expect(result?.extractor).toMatch(/^doc:word-extractor@/)
  })

  it("**reads RTF**: its code page, \\u escapes and symbols, without fonts, styles or hidden groups", async () => {
    const rtf = String.raw`{\rtf1\ansi\ansicpg1251\deff0{\fonttbl{\f0 Times New Roman;}}{\colortbl;\red0\green0\blue0;}
{\*\generator Synthetic;}{\info{\title hidden title}}\pard\plain Heron \b rtfneedle\b0  count\par
\'d6\'e0\'ef\'eb\'ff and \u1094?\u1072? \{braces\}\tab end\par}`
    const result = await textFrom(bytes(rtf), "rtf")
    expect(result?.text).toBe("Heron rtfneedle count\nЦапля and ца {braces}\tend")
    expect(result?.extractor).toBe("rtf:v1")
  })

  it("**reads HTML** without scripts, styles, comments or tags, entities decoded", async () => {
    const html =
      "<!doctype html><html><head><title>hidden</title><style>p{}</style></head><body><h1>Report</h1>" +
      "<p>htmlneedle &amp; more&nbsp;text &#1046; &#x416;</p><!-- secret --><script>alert(1)</script>" +
      "<table><tr><td>a</td><td>b</td></tr></table></body></html>"
    const result = await textFrom(bytes(html), "html")
    expect(result?.extractor).toBe("html:v2")
    expect(result?.text).toContain("## Report")
    expect(result?.text).toContain("htmlneedle & more text Ж Ж")
    expect(result?.text).toContain("| a | b |")
    expect(result?.text).not.toMatch(/hidden|secret|alert|p\{\}/)
    const plain = await extractText(bytes(html), hint("html"), async () => {
      throw new Error("no engines")
    })
    expect(plain).toMatchObject({ extractor: "html:v1" })
    if (plain.status === "extracted") {
      expect(plain.text).toContain("htmlneedle & more\u00A0text Ж Ж")
      expect(plain.text).toContain("a\tb")
    }
  })

  it("leaves .xls and .ppt, and a .doc that is not one, unsupported", async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])
    for (const kind of ["xls", "ppt"])
      expect(await extractText(ole, hint(kind), importEngine)).toMatchObject({ status: "unsupported" })
    expect(await extractText(bytes("not a document"), hint("doc"), importEngine)).toMatchObject({
      status: "unsupported",
    })
  })
})
