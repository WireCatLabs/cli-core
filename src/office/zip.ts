import { crc32 } from "node:zlib"
import { CliError } from "@wirecat/cli-base"
import { deflateSync } from "fflate"
import { ReaderLimit, readContainer } from "../attachments/container.js"

interface RawEntry {
  readonly name: string
  readonly central: number
  readonly centralEnd: number
  readonly local: number
}

const decoder = new TextDecoder()

/** The XML parts of an Office file, after `readContainer`'s checks: sizes, checksums, names, no encryption. */
export const openPackage = async (bytes: Uint8Array) => {
  try {
    return await readContainer(bytes)
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError(
      "validation_error",
      error instanceof ReaderLimit
        ? "the file is too large to edit (over 50 MB of unpacked text, 10 MB in one part or 1,000 entries)"
        : `the file is not a readable Office file (${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

const endRecord = (view: DataView) => {
  for (let index = view.byteLength - 22; index >= Math.max(0, view.byteLength - 65_557); index--)
    if (view.getUint32(index, true) === 0x06054b50) return index
  throw new CliError("validation_error", "the file is not a zip archive")
}

const entriesOf = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const end = endRecord(view)
  const count = view.getUint16(end + 10, true)
  const directory = view.getUint32(end + 16, true)
  const entries: RawEntry[] = []
  let offset = directory
  for (let index = 0; index < count; index++) {
    const length = view.getUint16(offset + 28, true)
    const next = offset + 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true)
    entries.push({
      name: decoder.decode(bytes.subarray(offset + 46, offset + 46 + length)),
      central: offset,
      centralEnd: next,
      local: view.getUint32(offset + 42, true),
    })
    offset = next
  }
  return { view, end, directory, entries }
}

const concat = (parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

/**
 * The archive with some entries replaced (or removed with `null`). Every other entry — its local header, compressed
 * data, data descriptor and central record — is copied byte for byte, in the original order, so images, fonts and
 * parts this module never reads come out exactly as they went in.
 */
export const rewriteZip = (bytes: Uint8Array, replaced: ReadonlyMap<string, Uint8Array | null>) => {
  const { view, end, directory, entries } = entriesOf(bytes)
  const starts = [...entries.map((entry) => entry.local), directory].sort((a, b) => a - b)
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let written = 0
  let kept = 0
  for (const entry of entries) {
    const replacement = replaced.get(entry.name)
    if (replacement === null) continue
    const central = bytes.slice(entry.central, entry.centralEnd)
    const centralView = new DataView(central.buffer)
    let local: Uint8Array
    if (replacement === undefined) {
      const spanEnd = starts.find((start) => start > entry.local) as number
      local = bytes.subarray(entry.local, spanEnd)
    } else {
      const header = entry.local + 30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true)
      const data = deflateSync(replacement, { level: 6 })
      local = concat([bytes.slice(entry.local, header), data])
      const localView = new DataView(local.buffer)
      for (const [target, base] of [
        [localView, 0],
        [centralView, 2],
      ] as const) {
        target.setUint16(base + 6, target.getUint16(base + 6, true) & ~0x0008, true)
        target.setUint16(base + 8, 8, true)
        target.setUint32(base + 14, crc32(replacement), true)
        target.setUint32(base + 18, data.length, true)
        target.setUint32(base + 22, replacement.length, true)
      }
    }
    centralView.setUint32(42, written, true)
    locals.push(local)
    centrals.push(central)
    written += local.length
    kept++
  }
  const tail = bytes.slice(end)
  const tailView = new DataView(tail.buffer)
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  tailView.setUint16(8, kept, true)
  tailView.setUint16(10, kept, true)
  tailView.setUint32(12, centralSize, true)
  tailView.setUint32(16, written, true)
  return concat([...locals, ...centrals, tail])
}

/** The raw bytes an entry occupies, local header to the next entry — what a byte-for-byte copy must keep. */
export const rawEntry = (bytes: Uint8Array, name: string) => {
  const { directory, entries } = entriesOf(bytes)
  const entry = entries.find((candidate) => candidate.name === name)
  if (!entry) return undefined
  const starts = [...entries.map((other) => other.local), directory].sort((a, b) => a - b)
  return bytes.subarray(
    entry.local,
    starts.find((start) => start > entry.local),
  )
}
