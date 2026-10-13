import { zip } from "./files.js"

export const ODF_OFFICE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0"
export const ODF_TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"
export const ODF_TABLE = "urn:oasis:names:tc:opendocument:xmlns:table:1.0"
export const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
export const SLIDE_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
export const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
export const PACKAGE_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
const types = (path: string, type: string) =>
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${path}" ContentType="${type}"/></Types>`
const rels = (content: string) => `<Relationships xmlns="${PACKAGE_NS}">${content}</Relationships>`
const relation = (id: string, target: string, type: string) =>
  `<Relationship Id="${id}" Target="${target}" Type="${REL_NS}/${type}"/>`

export const presentationEntries = (): Record<string, string> => ({
  mimetype: "application/vnd.oasis.opendocument.presentation",
  "content.xml": `<office:document-content xmlns:office="${ODF_OFFICE}" xmlns:text="${ODF_TEXT}" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"><office:body><office:presentation><draw:page draw:name="one"><draw:frame><draw:text-box><text:p>First slideneedle</text:p></draw:text-box></draw:frame></draw:page><draw:page draw:name="two"><draw:frame><draw:text-box><text:p>Later <text:span>слайд</text:span></text:p></draw:text-box></draw:frame></draw:page></office:presentation></office:body></office:document-content>`,
})
export const odfEntries = (kind: "odt" | "ods", content?: string): Record<string, string> => ({
  mimetype: `application/vnd.oasis.opendocument.${kind === "odt" ? "text" : "spreadsheet"}`,
  "content.xml": `<office:document-content xmlns:office="${ODF_OFFICE}" xmlns:text="${ODF_TEXT}" xmlns:table="${ODF_TABLE}"><office:body><office:${kind === "odt" ? "text" : "spreadsheet"}>${content ?? (kind === "odt" ? '<text:h>Heading</text:h><text:p>readerneedle <text:span>Привет</text:span><text:s text:c="3"/>world<text:tab/>42<text:line-break/>next</text:p>' : '<table:table table:name="Budget"><table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="2"><text:p>cellneedle</text:p></table:table-cell><table:table-cell office:value="42" table:formula="of:=SUM([.A1:.B1])"/></table:table-row><table:table-row table:number-rows-repeated="1048574"><table:table-cell table:number-columns-repeated="16384"/></table:table-row></table:table>')}</office:${kind === "odt" ? "text" : "spreadsheet"}></office:body></office:document-content>`,
})
export const sheetEntries = (): Record<string, string> => ({
  "[Content_Types].xml": types(
    "xl/workbook.xml",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  ),
  "_rels/.rels": rels(relation("main", "xl/workbook.xml", "officeDocument")),
  "xl/workbook.xml": `<workbook xmlns="${SHEET_NS}" xmlns:alternate="${REL_NS}"><sheets><sheet name="First" alternate:id="second"/><sheet name="Second" alternate:id="first"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": rels(
    relation("first", "worksheets/one.xml", "worksheet") +
      relation("second", "worksheets/two.xml", "worksheet") +
      relation("strings", "sharedStrings.xml", "sharedStrings"),
  ),
  "xl/sharedStrings.xml": `<sst xmlns="${SHEET_NS}"><si><r><t>shared</t></r><r><t>needle</t></r></si></sst>`,
  "xl/worksheets/one.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row><c r="B7" t="s"><v>0</v></c></row></sheetData></worksheet>`,
  "xl/worksheets/two.xml": `<worksheet xmlns="${SHEET_NS}"><sheetData><row><c r="A1" t="inlineStr"><is><t>inline Привет</t></is></c><c r="C2"><f>SUM(A1:B1)</f><v>12</v></c><c r="D2"><f>1+1</f></c></row></sheetData></worksheet>`,
})
export const slideEntries = (): Record<string, string> => ({
  "[Content_Types].xml": types(
    "ppt/presentation.xml",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  ),
  "_rels/.rels": rels(relation("main", "ppt/presentation.xml", "officeDocument")),
  "ppt/presentation.xml": `<p:presentation xmlns:p="${SLIDE_NS}" xmlns:r="${REL_NS}"><p:sldIdLst><p:sldId r:id="second"/><p:sldId r:id="first"/></p:sldIdLst></p:presentation>`,
  "ppt/_rels/presentation.xml.rels": rels(
    relation("first", "slides/one.xml", "slide") + relation("second", "slides/two.xml", "slide"),
  ),
  ...Object.fromEntries(
    [
      ["one", "Later slide"],
      ["two", "First slideneedle"],
    ].map(([name, text]) => [
      `ppt/slides/${name}.xml`,
      `<p:sld xmlns:p="${SLIDE_NS}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    ]),
  ),
})
export const bookEntries = (): Record<string, string> => ({
  mimetype: "application/epub+zip",
  "META-INF/container.xml":
    '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="Book/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  "Book/package.opf":
    '<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="two"/><itemref idref="one"/></spine></package>',
  "Book/one.xhtml":
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>hidden title</title></head><body><p>Later book chapter</p></body></html>',
  "Book/two.xhtml":
    '<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><body><p>First <em>bookneedle</em> Привет</p><script>must not execute</script><style>hidden style</style></body></html>',
})
export const officeFixture = (kind: "odt" | "ods" | "odp" | "xlsx" | "pptx" | "epub") =>
  zip(
    kind === "odt" || kind === "ods"
      ? odfEntries(kind)
      : kind === "odp"
        ? presentationEntries()
        : kind === "xlsx"
          ? sheetEntries()
          : kind === "pptx"
            ? slideEntries()
            : bookEntries(),
  )
