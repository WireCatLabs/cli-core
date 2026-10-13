import { doc } from "./doc/index.js"
import { docx } from "./docx/index.js"
import { html } from "./html/index.js"
import { image } from "./image/index.js"
import { office } from "./office/index.js"
import { pdf } from "./pdf/index.js"
import { plain } from "./plain/index.js"
import { rtf } from "./rtf/index.js"
import { sheets } from "./sheets/index.js"
import type { Extraction, FileHint, ReadContext, Reader } from "./types.js"

/** The order is the contract: the first reader that accepts a file reads it. */
const BUILT_INS: readonly Reader[] = [office, pdf, docx, doc, rtf, html, sheets, plain, image]
const HEAD_BYTES = 1024

let readers: Reader[] = [...BUILT_INS]

export const registeredReaders = (): readonly Reader[] => readers

/** Adds a reader, or replaces the one with the same id in place. `before` puts it ahead of another reader. */
export const registerReader = (reader: Reader, options: { before?: string } = {}): (() => void) => {
  const without = readers.filter((existing) => existing.id !== reader.id)
  let at = readers.findIndex((existing) => existing.id === reader.id)
  if (options.before !== undefined) {
    at = without.findIndex((existing) => existing.id === options.before)
    if (at === -1) throw new Error(`no reader named ${options.before} to register ${reader.id} before`)
  } else if (at === -1) at = without.length
  readers = [...without.slice(0, at), reader, ...without.slice(at)]
  return () => {
    readers = readers.filter((existing) => existing !== reader)
  }
}

export const readWithRegistry = async (
  bytes: Uint8Array,
  hint: FileHint,
  context: ReadContext,
): Promise<Extraction> => {
  const head = bytes.subarray(0, HEAD_BYTES)
  const reader = readers.find((candidate) => candidate.accepts(hint, head))
  return reader ? reader.read(bytes, hint, context) : { status: "unsupported" }
}
