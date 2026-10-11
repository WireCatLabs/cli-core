import { setImmediate as tick } from "node:timers/promises"
import { crc32 } from "node:zlib"
import { CliError } from "@wirecat/cli-base"
import { DOMParser, type Document, type Element, type Node } from "@xmldom/xmldom"
import { Unzip, UnzipInflate } from "fflate"
import { decodeXml } from "./encoding.js"

import { MAX_FILE_BYTES as MAX_EXPANDED } from "./limits.js"

const MAX_PART = 10 * 1024 * 1024
const MAX_ENTRIES = 1000
const decoder = new TextDecoder("utf-8", { fatal: true })

export class ReaderLimit extends Error {}
const cancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new CliError("cancelled", "document extraction cancelled")
}
const safeName = (name: string) =>
  name.length > 0 &&
  name.length <= 512 &&
  !/^[\\/]|\\/.test(name) &&
  ![...name].some((character) => character.charCodeAt(0) < 32) &&
  !name.split("/").includes("..")

const directory = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index--) {
    if (view.getUint32(index, true) === 0x06054b50 && index + 22 + view.getUint16(index + 20, true) === bytes.length) {
      end = index
      break
    }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error("invalid_zip")
  const count = view.getUint16(end + 10, true)
  if (count > MAX_ENTRIES) throw new ReaderLimit()
  if (count !== view.getUint16(end + 8, true)) throw new Error("invalid_zip")
  const stop = view.getUint32(end + 16, true) + view.getUint32(end + 12, true)
  if (stop > end) throw new Error("invalid_zip")
  let offset = view.getUint32(end + 16, true)
  let expanded = 0
  const entries = new Map<string, { size: number; crc: number }>()
  for (let index = 0; index < count; index++) {
    if (offset + 46 > stop || view.getUint32(offset, true) !== 0x02014b50) throw new Error("invalid_zip")
    const flags = view.getUint16(offset + 8, true)
    const method = view.getUint16(offset + 10, true)
    const size = view.getUint32(offset + 24, true)
    const compressed = view.getUint32(offset + 20, true)
    const length = view.getUint16(offset + 28, true)
    const next = offset + 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
    if (next > stop) throw new Error("invalid_zip")
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + length))
    if (!safeName(name) || entries.has(name) || flags & 1 || (method !== 0 && method !== 8))
      throw new Error("invalid_zip")
    if (((view.getUint32(offset + 38, true) >>> 16) & 0xf000) === 0xa000) throw new Error("invalid_zip")
    expanded += size
    if (expanded > MAX_EXPANDED) throw new ReaderLimit()
    const local = view.getUint32(offset + 42, true)
    if (local + 30 > offset || view.getUint32(local, true) !== 0x04034b50) throw new Error("invalid_zip")
    const localLength = view.getUint16(local + 26, true)
    const start = local + 30 + localLength + view.getUint16(local + 28, true)
    if (
      start + compressed > view.getUint32(end + 16, true) ||
      decoder.decode(bytes.subarray(local + 30, local + 30 + localLength)) !== name ||
      view.getUint16(local + 6, true) !== flags ||
      view.getUint16(local + 8, true) !== method
    )
      throw new Error("invalid_zip")
    if (
      !(flags & 8) &&
      (view.getUint32(local + 14, true) !== view.getUint32(offset + 16, true) ||
        view.getUint32(local + 18, true) !== compressed ||
        view.getUint32(local + 22, true) !== size)
    )
      throw new Error("invalid_zip")
    entries.set(name, { size, crc: view.getUint32(offset + 16, true) })
    offset = next
  }
  if (offset !== stop) throw new Error("invalid_zip")
  return entries
}

export const readContainer = async (bytes: Uint8Array, signal?: AbortSignal): Promise<Map<string, Uint8Array>> => {
  cancelled(signal)
  const entries = directory(bytes)
  const result = new Map<string, Uint8Array>()
  const seen = new Set<string>()
  const done = new Set<string>()
  let expanded = 0
  const archive = new Unzip((file) => {
    const expected = entries.get(file.name)
    if (!expected || seen.has(file.name)) throw new Error("invalid_zip")
    seen.add(file.name)
    const keep = /\.(xml|rels|opf|xhtml|html)$/i.test(file.name) || file.name === "mimetype"
    let size = 0
    let checksum = 0
    const parts: Uint8Array[] = []
    file.ondata = (error, data, final) => {
      if (error) throw error
      size += data.length
      expanded += data.length
      if (expanded > MAX_EXPANDED || (keep && size > MAX_PART)) throw new ReaderLimit()
      checksum = crc32(data, checksum)
      if (keep) parts.push(data.slice())
      if (final) {
        if (size !== expected.size || checksum !== expected.crc) throw new Error("invalid_zip")
        done.add(file.name)
        if (keep) {
          const content = new Uint8Array(size)
          let offset = 0
          for (const part of parts) {
            content.set(part, offset)
            offset += part.length
          }
          result.set(file.name, content)
          parts.length = 0
        }
      }
    }
    file.start()
  })
  archive.register(UnzipInflate)
  // Small compressed chunks bound allocation before the expanded-byte check runs.
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    cancelled(signal)
    archive.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length)
    if (offset % 65_536 === 0) await tick()
  }
  cancelled(signal)
  if (seen.size !== entries.size || done.size !== entries.size) throw new Error("incomplete_zip")
  return result
}

const checkXml = (text: string) => {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("unsupported_xml")
  let depth = 0
  let nodes = 0
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "<") continue
    const skip = text.startsWith("<!--", index)
      ? "-->"
      : text.startsWith("<![CDATA[", index)
        ? "]]>"
        : text.startsWith("<?", index)
          ? "?>"
          : undefined
    if (skip) {
      if (++nodes > 200_000) throw new ReaderLimit()
      const end = text.indexOf(skip, index + 2)
      if (end < 0) throw new Error("invalid_xml")
      index = end + skip.length - 1
      continue
    }
    const start = index
    let quote = ""
    for (index++; index < text.length; index++) {
      const char = text[index]
      if (quote) {
        if (char === quote) quote = ""
      } else if (char === '"' || char === "'") quote = char
      else if (char === ">") break
    }
    if (index === text.length) throw new Error("invalid_xml")
    const tag = text.slice(start, index + 1)
    if (tag.startsWith("</")) depth--
    else if (!/\/\s*>$/.test(tag)) depth++
    if (++nodes > 200_000 || depth > 128) throw new ReaderLimit()
    if (depth < 0) throw new Error("invalid_xml")
  }
  if (depth !== 0) throw new Error("invalid_xml")
}

export const xmlPart = (archive: Map<string, Uint8Array>, path: string): Document => {
  const bytes = archive.get(path)
  if (!bytes) throw new Error("missing_part")
  let text = decodeXml(bytes)
  if (/\.xhtml$/i.test(path)) {
    let start = 0
    while (start < text.length) {
      start += /^\s*/.exec(text.slice(start))?.[0].length ?? 0
      const end = text.startsWith("<?", start) ? "?>" : text.startsWith("<!--", start) ? "-->" : undefined
      if (!end) break
      const index = text.indexOf(end, start + 2)
      if (index < 0) throw new Error("invalid_xml")
      start = index + end.length
    }
    const doctype = /^<!DOCTYPE\s+html\s*>/i.exec(text.slice(start))
    if (doctype) text = text.slice(0, start) + text.slice(start + doctype[0].length)
  }
  checkXml(text)
  const document = new DOMParser({
    onError: () => {
      throw new Error("invalid_xml")
    },
  }).parseFromString(text, "application/xml")
  if (!document.documentElement) throw new Error("invalid_xml")
  return document
}

export const elements = (node: Node, name: string, namespace: string): Element[] => {
  const found: Element[] = []
  const visit = (current: Node) => {
    if (current.nodeType === 1 && current.localName === name && current.namespaceURI === namespace)
      found.push(current as Element)
    for (let child = current.firstChild; child; child = child.nextSibling) visit(child)
  }
  visit(node)
  return found
}
