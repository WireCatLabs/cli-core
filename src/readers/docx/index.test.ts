import { readFileSync } from "node:fs"
import { strToU8, zipSync } from "fflate"
import mammoth from "mammoth"
import { describe, expect, it } from "vitest"
import { MAX_TEXT_CHARS } from "../../attachments/limits.js"
import { zip } from "../../testing/files.js"
import type { LoadEngine } from "../types.js"
import { docx } from "./index.js"

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../testing/fixtures/${name}`, import.meta.url)))
const hint = { kind: "file", name: "synthetic.docx", mime: null, path: "/saved/synthetic.docx" }
const load: LoadEngine = async (name) => {
  throw new Error(`the Word reader loaded ${name}`)
}
const read = (bytes: Uint8Array) => docx.read(bytes, hint, { load })
const ours = async (bytes: Uint8Array) => {
  const found = await read(bytes)
  if (found.status !== "extracted") throw new Error(`not extracted: ${found.status}`)
  return found.text
}
const theirs = async (bytes: Uint8Array) => (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value

const zipEntries = (entries: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(entries).map(([name, text]) => [name, strToU8(text)])))
const MAIN = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const word = (body: string, { namespace = MAIN, rels = true } = {}) =>
  zipEntries({
    ...(rels
      ? {
          "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/main.xml"/></Relationships>`,
        }
      : {}),
    [rels ? "word/main.xml" : "word/document.xml"]:
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${namespace}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><w:body>${body}</w:body></w:document>`,
  })
const p = (inner: string) => `<w:p>${inner}</w:p>`
const r = (inner: string) => `<w:r>${inner}</w:r>`
const t = (text: string) => r(`<w:t xml:space="preserve">${text}</w:t>`)

describe("the Word reader, against mammoth's raw text", () => {
  it.each(["letter.docx", "pond-lists.docx"])(
    "**gives mammoth's text for %s**: paragraphs, headings, list items and table cells",
    async (name) => {
      const bytes = fixture(name)
      expect(await ours(bytes)).toBe(await theirs(bytes))
    },
  )

  it("**keeps a line break that mammoth drops**, and leaves the footnotes out as mammoth does", async () => {
    const bytes = fixture("field-notes.docx")
    const text = await ours(bytes)
    expect(text).toContain("with a line\nbreak and")
    expect(text.replace("line\nbreak", "linebreak")).toBe(await theirs(bytes))
    expect(text).not.toContain("willow")
  })

  it.each([
    [
      "tracked changes: an insertion stays, a deletion and a move away go",
      p(
        `${t("kept ")}<w:ins>${t("added")}</w:ins><w:del>${r("<w:delText>gone</w:delText>")}</w:del><w:moveFrom>${t("moved")}</w:moveFrom>`,
      ),
      "kept added\n\n",
    ],
    [
      "a text box drawn two ways, read once and after its paragraph",
      p(
        `${t("Body ")}${r(`<mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent>${p(t("Boxed"))}</w:txbxContent></wps:txbx></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent>${p(t("Boxed"))}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent>`)}`,
      ),
      "Body \n\nBoxed\n\n",
    ],
    [
      "a field: its result, not its code",
      p(
        `${r('<w:fldChar w:fldCharType="begin"/>')}${r("<w:instrText> PAGE </w:instrText>")}${r('<w:fldChar w:fldCharType="separate"/>')}${t("7")}${r('<w:fldChar w:fldCharType="end"/>')}`,
      ),
      "7\n\n",
    ],
    [
      "tab stops in the properties are not tabs; a tab in the text is",
      p(`<w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>${t("a")}${r("<w:tab/>")}${t("b")}`),
      "a\tb\n\n",
    ],
    [
      "a content control and a hyperlink",
      `<w:sdt><w:sdtPr><w:alias w:val="Name"/></w:sdtPr><w:sdtContent>${p(`<w:hyperlink w:anchor="x">${t("Linked")}</w:hyperlink>`)}</w:sdtContent></w:sdt>`,
      "Linked\n\n",
    ],
    [
      "hyphens Word keeps as marks",
      p(`${t("non")}${r("<w:noBreakHyphen/>")}${t("stop co")}${r("<w:softHyphen/>")}${t("operate")}`),
      "non\u2011stop co\u00adoperate\n\n",
    ],
  ])("reads %s, the same as mammoth", async (_, body, expected) => {
    const bytes = word(body)
    expect(await ours(bytes)).toBe(expected)
    expect(await theirs(bytes)).toBe(expected)
  })

  it("**reads a simple field's text, which mammoth drops**", async () => {
    const bytes = word(p(`${t("Page ")}<w:fldSimple w:instr=" PAGE ">${t("3")}</w:fldSimple>`))
    expect(await ours(bytes)).toBe("Page 3\n\n")
    expect(await theirs(bytes)).toBe("Page \n\n")
  })

  it("reads the Strict namespace and a package with no relationships, as mammoth does", async () => {
    for (const bytes of [
      word(p(t("strict")), { namespace: "http://purl.oclc.org/ooxml/wordprocessingml/main" }),
      word(p(t("strict")), { rels: false }),
    ]) {
      expect(await ours(bytes)).toBe("strict\n\n")
      expect(await theirs(bytes)).toBe("strict\n\n")
    }
  })
})

describe("the Word reader, on what it cannot read", () => {
  it("**marks a damaged file unreadable**: a cut zip, broken XML, no body, another format", async () => {
    const letter = fixture("letter.docx")
    for (const bytes of [
      letter.subarray(0, letter.length - 200),
      zip({ "word/document.xml": `<w:document xmlns:w="${MAIN}"><w:body><w:p>` }),
      zip({ "word/document.xml": `<w:document xmlns:w="${MAIN}"/>` }),
      zip({ "word/document.xml": "<office:document-content xmlns:office='urn:x'/>" }),
      zip({ "word/document.xml": `<!DOCTYPE x [<!ENTITY a "b">]><w:document xmlns:w="${MAIN}"/>` }),
    ])
      expect(await read(bytes)).toEqual({ status: "unreadable", extractor: "docx:v1", error: "unreadable" })
  })

  it("leaves a document with no text to an agent", async () => {
    expect(await read(word(p("")))).toEqual({ status: "needs-agent", extractor: "docx:v1" })
  })

  it("reads a long body with more tags than the other office parts may have", async () => {
    const text = await ours(word(p(t("x")).repeat(60_000)))
    expect(text.length).toBe(3 * 60_000)
  })

  it("cuts a long document at the text budget instead of refusing it", async () => {
    const found = await read(word(p(t("a".repeat(MAX_TEXT_CHARS + 10)))))
    expect(found).toMatchObject({ status: "extracted", extractor: "docx:v1" })
    expect(found.status === "extracted" && found.text.length).toBe(MAX_TEXT_CHARS)
  })
})
