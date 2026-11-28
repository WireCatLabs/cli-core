import type { Element, Node } from "@xmldom/xmldom"
import { readContainer, xmlPart } from "../../attachments/container.js"
import { relationships } from "../../attachments/documents.js"
import { capped, extensionOf, guarded, startsWith } from "../engine.js"
import type { Reader } from "../types.js"

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const EXTRACTOR = "docx:v1"
const WORD = [
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]
const COMPATIBILITY = "http://schemas.openxmlformats.org/markup-compatibility/2006"
// Properties hold tab stops and deletion marks, not text; deleted and moved-away runs are not the document's text.
const SKIPPED = new Set(["pPr", "rPr", "sectPr", "sdtPr", "del", "moveFrom"])
// A long Word body runs past the 200,000 tags other parts may have (370,000 for 1.1 million characters measured);
// the 10 MB part limit still bounds it.
const MAX_NODES = 1_000_000
const CHARACTERS: Record<string, string> = {
  tab: "\t",
  br: "\n",
  cr: "\n",
  noBreakHyphen: "\u2011",
  softHyphen: "\u00ad",
}

/** The main part as mammoth finds it: the package's officeDocument relationship, else the usual path. */
const mainDocument = (archive: Map<string, Uint8Array>) => {
  const declared = archive.has("_rels/.rels")
    ? [...relationships(archive, "").values()].find(
        (entry) => entry.type.endsWith("/officeDocument") && archive.has(entry.path),
      )?.path
    : undefined
  return declared ?? "word/document.xml"
}

/** `hoisted` collects paragraphs met inside a paragraph (a text box), which mammoth puts after it. */
const textOf = (node: Node, namespace: string, parts: string[], hoisted?: string[]) => {
  if (node.nodeType !== 1) return
  const element = node as Element
  // An alternate content block repeats one thing several ways; the fallback is the one every reader understands.
  if (element.namespaceURI === COMPATIBILITY && element.localName === "Choice") return
  const word = element.namespaceURI === namespace
  if (word && SKIPPED.has(element.localName ?? "")) return
  if (word && element.localName === "t") {
    parts.push(element.textContent ?? "")
    return
  }
  const character = word ? CHARACTERS[element.localName ?? ""] : undefined
  if (character !== undefined) {
    parts.push(character)
    return
  }
  if (word && element.localName === "p") {
    const own: string[] = []
    const inner: string[] = []
    for (let child = element.firstChild; child; child = child.nextSibling) textOf(child, namespace, own, inner)
    ;(hoisted ?? parts).push(`${own.join("")}\n\n${inner.join("")}`)
    return
  }
  for (let child = element.firstChild; child; child = child.nextSibling) textOf(child, namespace, parts, hoisted)
}

/** The body's text, paragraphs and table cells alike, each followed by a blank line, as mammoth's raw text gives it. */
export const docxText = (archive: Map<string, Uint8Array>) => {
  const root = xmlPart(archive, mainDocument(archive), MAX_NODES).documentElement
  const namespace = root?.namespaceURI ?? ""
  if (root?.localName !== "document" || !WORD.includes(namespace)) throw new Error("wrong_format")
  let body: Node | null = root.firstChild
  while (body && !(body.nodeType === 1 && body.namespaceURI === namespace && body.localName === "body"))
    body = body.nextSibling
  if (!body) throw new Error("missing_body")
  const parts: string[] = []
  textOf(body, namespace, parts)
  return parts.join("")
}

export const docx: Reader = {
  id: "docx",
  version: EXTRACTOR,
  accepts: (hint, head) => startsWith(head, "PK\u0003\u0004") && (extensionOf(hint) === ".docx" || hint.mime === DOCX),
  read: (bytes, _hint, { signal }) =>
    guarded(EXTRACTOR, async () => {
      const text = docxText(await readContainer(bytes, signal))
      return text.trim() === ""
        ? { status: "needs-agent", extractor: EXTRACTOR }
        : { status: "extracted", text: capped(text), extractor: EXTRACTOR }
    }),
}
