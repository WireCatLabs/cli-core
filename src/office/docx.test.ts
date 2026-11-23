import { readFileSync } from "node:fs"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import mammoth from "mammoth"
import { describe, expect, it } from "vitest"
import { editDocxParagraphs, readDocxParagraphs } from "./index.js"
import { rawEntry } from "./zip.js"

const letter = new Uint8Array(readFileSync(new URL("../testing/fixtures/letter.docx", import.meta.url)))
const DOCUMENT = "word/document.xml"

const entriesOf = (bytes: Uint8Array) => Object.keys(unzipSync(bytes))
const documentOf = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)[DOCUMENT] as Uint8Array)
const withDocument = (change: (xml: string) => string) => {
  const files = unzipSync(letter)
  files[DOCUMENT] = strToU8(change(documentOf(letter)))
  return zipSync(files, { level: 6, mtime: new Date(Date.UTC(2026, 0, 1)) })
}
const texts = async (bytes: Uint8Array) => (await readDocxParagraphs(bytes)).map((paragraph) => paragraph.text)
const rawText = async (bytes: Uint8Array) => (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value
/** Adds a paragraph after "Plain second paragraph." */
const addParagraph = (xml: string) =>
  withDocument((document) => document.replace("Plain second paragraph.</w:t></w:r></w:p>", `$&${xml}`))

describe("readDocxParagraphs", () => {
  it("**lists the body's paragraphs, table cells included**, with style, location and mixed formatting", async () => {
    const paragraphs = await readDocxParagraphs(letter)
    expect(paragraphs.map((paragraph) => paragraph.text)).toEqual([
      "Synthetic letter",
      "Dear heron, the pond is ready.",
      "Plain second paragraph.",
      "Cell one",
      "Cell two",
      "Closing words.",
    ])
    expect(paragraphs[0]).toEqual({
      index: 0,
      text: "Synthetic letter",
      styleId: "Heading1",
      style: "heading 1",
      location: "body",
      editable: true,
      mixedFormatting: false,
    })
    expect(paragraphs[1]).toMatchObject({ mixedFormatting: true, editable: true })
    expect(paragraphs[3]).toMatchObject({ location: "table", styleId: "TableContents" })
  })

  it("**marks what it cannot rewrite safely**, each with the reason", async () => {
    const reasons = async (xml: string) => (await readDocxParagraphs(addParagraph(xml)))[3]
    expect(await reasons('<w:p><w:ins w:id="1" w:author="A"><w:r><w:t>added</w:t></w:r></w:ins></w:p>')).toMatchObject({
      text: "added",
      editable: false,
      reason: "it holds a tracked change",
    })
    expect(await reasons("<w:p><w:r><w:drawing/></w:r><w:r><w:t>caption</w:t></w:r></w:p>")).toMatchObject({
      text: "caption",
      reason: "it holds an image or a drawing",
    })
    expect(
      await reasons('<w:p><w:r><w:t>see</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r></w:p>'),
    ).toMatchObject({
      reason: "it holds a footnote reference",
    })
    expect(
      await reasons(
        '<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>noted</w:t></w:r><w:commentRangeEnd w:id="0"/></w:p>',
      ),
    ).toMatchObject({ reason: "it holds a comment" })
    expect(
      await reasons(
        '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r></w:p>',
      ),
    ).toMatchObject({ reason: "it holds a field" })
    expect(await reasons('<w:p><w:r><w:rPr><w:rPrChange w:id="3"/></w:rPr><w:t>x</w:t></w:r></w:p>')).toMatchObject({
      reason: "it holds a tracked change",
    })
    expect(
      await reasons(
        '<w:sdt><w:sdtPr><w:lock w:val="contentLocked"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>locked</w:t></w:r></w:p></w:sdtContent></w:sdt>',
      ),
    ).toMatchObject({ text: "locked", reason: "it sits in a locked or data-bound content control" })
    expect(await reasons("<w:p><w:r><w:t>a</w:t><w:unknownThing/></w:r></w:p>")).toMatchObject({
      reason: "unsupported element <w:unknownThing>",
    })
  })
})

describe("editDocxParagraphs", () => {
  it("**replaces text keeping the paragraph's properties and the first run's formatting**", async () => {
    const result = await editDocxParagraphs(letter, [{ index: 1, text: "Dear crane & <friends> 🦩\tsee\nyou" }])
    expect(result).toMatchObject({ replaced: [1], collapsed: [1], inserted: 0, deleted: [] })
    const xml = documentOf(result.bytes)
    expect(xml).toContain(
      '<w:p><w:pPr><w:pStyle w:val="BodyText"/><w:bidi w:val="0"/><w:jc w:val="left"/><w:rPr></w:rPr></w:pPr><w:r><w:rPr></w:rPr><w:t xml:space="preserve">Dear crane &amp; &lt;friends&gt; 🦩</w:t><w:tab/><w:t xml:space="preserve">see</w:t><w:br/><w:t xml:space="preserve">you</w:t></w:r></w:p>',
    )
    expect((await readDocxParagraphs(result.bytes))[1]).toMatchObject({
      text: "Dear crane & <friends> 🦩\tsee\nyou",
      styleId: "BodyText",
      mixedFormatting: false,
    })
    // mammoth's raw text drops line breaks.
    expect(await rawText(result.bytes)).toContain("Dear crane & <friends> 🦩\tseeyou")
    for (const name of entriesOf(letter).filter((entry) => entry !== DOCUMENT))
      expect(rawEntry(result.bytes, name), name).toEqual(rawEntry(letter, name))
    expect(entriesOf(result.bytes)).toEqual(entriesOf(letter))
  })

  it("**inserts and deletes** by the original indexes, and the same edit gives the same bytes", async () => {
    const edits = [
      { insertAfter: 2, text: "A new heading", styleFrom: 0 },
      { delete: 2 },
      { insertAfter: -1, text: "Before all" },
      { insertAfter: 2, text: "Second insert" },
    ]
    const result = await editDocxParagraphs(letter, edits)
    expect(result).toMatchObject({ inserted: 3, deleted: [2] })
    const paragraphs = await readDocxParagraphs(result.bytes)
    expect(paragraphs.map((paragraph) => paragraph.text)).toEqual([
      "Before all",
      "Synthetic letter",
      "Dear heron, the pond is ready.",
      "A new heading",
      "Second insert",
      "Cell one",
      "Cell two",
      "Closing words.",
    ])
    expect(paragraphs.map((paragraph) => paragraph.styleId)).toEqual([
      "Heading1",
      "Heading1",
      "BodyText",
      "Heading1",
      "BodyText",
      "TableContents",
      "TableContents",
      "BodyText",
    ])
    expect((await editDocxParagraphs(letter, edits)).bytes).toEqual(result.bytes)
  })

  it("**copies a style without its section break**, and refuses to delete a section's end or the last paragraph", async () => {
    const sectioned = addParagraph(
      '<w:p><w:pPr><w:pStyle w:val="BodyText"/><w:sectPr><w:type w:val="nextPage"/></w:sectPr></w:pPr><w:r><w:t>Section end</w:t></w:r></w:p>',
    )
    const result = await editDocxParagraphs(sectioned, [{ insertAfter: 3, text: "Next section" }])
    expect(documentOf(result.bytes)).toContain(
      '<w:p><w:pPr><w:pStyle w:val="BodyText"/></w:pPr><w:r><w:t xml:space="preserve">Next section</w:t></w:r></w:p>',
    )
    await expect(editDocxParagraphs(sectioned, [{ delete: 3 }])).rejects.toMatchObject({
      details: { reason: "office.section_break" },
    })
    await expect(editDocxParagraphs(letter, [{ delete: 5 }])).rejects.toMatchObject({
      message: expect.stringContaining("the document must end with a paragraph"),
      details: { reason: "office.last_paragraph" },
    })
  })

  it("**edits a paragraph in a table cell** and refuses to leave a cell without one", async () => {
    const result = await editDocxParagraphs(letter, [{ index: 4, text: "Cell 2" }])
    expect(await texts(result.bytes)).toContain("Cell 2")
    expect(documentOf(result.bytes)).toMatch(/<w:tc>(?:(?!<\/w:tc>).)*Cell 2<\/w:t><\/w:r><\/w:p><\/w:tc>/)
    await expect(editDocxParagraphs(letter, [{ delete: 3 }])).rejects.toMatchObject({
      details: { reason: "office.last_paragraph" },
    })
    const kept = await editDocxParagraphs(letter, [{ insertAfter: 3, text: "More" }, { delete: 3 }])
    expect(await texts(kept.bytes)).toContain("More")
  })

  it("**refuses tracked-change and image paragraphs**, and conflicting or unknown indexes", async () => {
    const tracked = addParagraph(
      '<w:p><w:del w:id="1" w:author="A"><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>',
    )
    await expect(editDocxParagraphs(tracked, [{ index: 3, text: "x" }])).rejects.toMatchObject({
      code: "validation_error",
      details: { reason: "office.unsafe_paragraph" },
      message: "paragraph 3 cannot be replaced: it holds a tracked change",
    })
    const image = addParagraph("<w:p><w:r><w:drawing/></w:r></w:p>")
    await expect(editDocxParagraphs(image, [{ delete: 3 }])).rejects.toThrow(/image or a drawing/)
    await expect(editDocxParagraphs(letter, [{ index: 9, text: "x" }])).rejects.toThrow(/has 6 paragraphs/)
    await expect(editDocxParagraphs(letter, [{ index: 1, text: "x" }, { delete: 1 }])).rejects.toMatchObject({
      details: { reason: "office.duplicate_edit" },
    })
    await expect(editDocxParagraphs(letter, [{ index: 1, text: "nul\u0000" }])).rejects.toThrow(/control character/)
  })

  it("**keeps bookmarks** of a replaced paragraph and refuses to delete one that holds them", async () => {
    const marked = addParagraph(
      '<w:p w14:paraId="1A2B3C4D"><w:bookmarkStart w:id="7" w:name="target"/><w:r><w:t>old</w:t></w:r><w:proofErr w:type="spellStart"/><w:bookmarkEnd w:id="7"/></w:p>',
    )
    const result = await editDocxParagraphs(marked, [{ index: 3, text: "new" }])
    expect(documentOf(result.bytes)).toContain(
      '<w:p w14:paraId="1A2B3C4D"><w:bookmarkStart w:id="7" w:name="target"/><w:r><w:t xml:space="preserve">new</w:t></w:r><w:bookmarkEnd w:id="7"/></w:p>',
    )
    await expect(editDocxParagraphs(marked, [{ delete: 3 }])).rejects.toMatchObject({
      details: { reason: "office.bookmark" },
    })
    const copied = await editDocxParagraphs(marked, [{ insertAfter: 3, text: "after", styleFrom: 3 }])
    expect(documentOf(copied.bytes).match(/1A2B3C4D/g)).toHaveLength(1)
  })
})
