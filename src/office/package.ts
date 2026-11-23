import { CliError } from "@wirecat/cli-base"
import { xmlPart } from "../attachments/container.js"
import { mainPart, relationships } from "../attachments/documents.js"
import { applySplices, parseXml, partBytes, partText, type Splice, type XmlElement } from "./xml.js"
import { openPackage, rewriteZip } from "./zip.js"

export const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
export const STRICT_REL = "http://purl.oclc.org/ooxml/officeDocument/relationships"

const unreadable = (what: string, error: unknown) =>
  error instanceof CliError
    ? error
    : new CliError("validation_error", `the file is not a ${what} this editor reads (${(error as Error).message})`)

export interface Part {
  readonly path: string
  readonly text: string
  readonly root: XmlElement
}

/** An Office package opened for editing: its XML parts as text, and the parts the edit changed or removed. */
export class OfficePackage {
  private readonly changed = new Map<string, Uint8Array | null>()

  private constructor(
    readonly bytes: Uint8Array,
    readonly archive: Map<string, Uint8Array>,
    readonly what: string,
  ) {}

  static async open(bytes: Uint8Array, what: string) {
    return new OfficePackage(bytes, await openPackage(bytes), what)
  }

  main(contentType: string) {
    try {
      return mainPart(this.archive, contentType)
    } catch (error) {
      throw unreadable(this.what, error)
    }
  }

  relationships(owner: string) {
    try {
      return relationships(this.archive, owner)
    } catch (error) {
      throw unreadable(this.what, error)
    }
  }

  related(owner: string, type: string) {
    return [...this.relationships(owner).entries()].find(([, entry]) => entry.type.endsWith(`/${type}`))
  }

  has(path: string) {
    return this.archive.has(path)
  }

  part(path: string): Part {
    const bytes = this.archive.get(path)
    if (!bytes) throw new CliError("validation_error", `the ${this.what} has no ${path}`)
    try {
      xmlPart(this.archive, path)
    } catch (error) {
      throw unreadable(this.what, error)
    }
    const text = partText(bytes, path)
    return { path, text, root: parseXml(text) }
  }

  write(part: Part, splices: readonly Splice[]) {
    if (!splices.length) return
    const text = applySplices(part.text, splices)
    const bytes = partBytes(text)
    const archive = new Map(this.archive)
    archive.set(part.path, bytes)
    try {
      xmlPart(archive, part.path)
    } catch (error) {
      throw new Error(`the edit produced invalid XML in ${part.path} (${(error as Error).message})`)
    }
    this.changed.set(part.path, bytes)
  }

  remove(path: string) {
    this.changed.set(path, null)
  }

  /** The new file: changed parts recompressed, every other entry copied as it was. */
  build() {
    return this.changed.size ? rewriteZip(this.bytes, this.changed) : this.bytes.slice()
  }
}

const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;")

/** A start tag with one attribute set (added at the end when it was not there). */
export const withAttribute = (tag: string, name: string, value: string) => {
  const pattern = new RegExp(`(\\s)${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`)
  if (pattern.test(tag)) return tag.replace(pattern, `$1${name}="${escapeAttribute(value)}"`)
  return tag.replace(/\s*(\/?)>$/, ` ${name}="${escapeAttribute(value)}"$1>`)
}

export const withoutAttribute = (tag: string, name: string) =>
  tag.replace(new RegExp(`\\s+${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`), "")

export const startTag = (text: string, element: XmlElement) => text.slice(element.start, element.openEnd)

export const isSelfClosing = (text: string, element: XmlElement) =>
  /\/\s*>$/.test(text.slice(element.start, element.openEnd))

export const openTag = (text: string, element: XmlElement) => {
  const tag = text.slice(element.start, element.openEnd)
  return isSelfClosing(text, element) ? tag.replace(/\s*\/\s*>$/, ">") : tag
}

export const qualified = (element: XmlElement, local: string) => (element.prefix ? `${element.prefix}:${local}` : local)
