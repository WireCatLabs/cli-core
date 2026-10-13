import { readFileSync } from "node:fs"
import { dirname, extname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { isCliError } from "@wirecat/cli-base"
import { ReaderLimit } from "../attachments/container.js"
import { decodeText } from "../attachments/encoding.js"
import { MAX_TEXT_CHARS } from "../attachments/limits.js"
import type { Extraction, FileHint, LoadEngine } from "./types.js"

/**
 * The packages that read formats. Reading documents is core, so the readers ship with this package (owner,
 * 2026-10-12, replacing NEED-629 A); only the page renderer for OCR stays optional, a native binary.
 */
export const BUILT_IN = ["unpdf", "mammoth", "word-extractor"] as const
export const ENGINES = [...BUILT_IN, "@napi-rs/canvas"] as const
export type Engine = (typeof ENGINES)[number]

const isMissing = (error: unknown, name: Engine) =>
  (error as NodeJS.ErrnoException)?.code === "ERR_MODULE_NOT_FOUND" && String((error as Error).message).includes(name)

/** `name@version` from the package's own manifest, found beside the module that loaded. */
const versionOf = (name: Engine): string => {
  try {
    let directory = dirname(fileURLToPath(import.meta.resolve(name)))
    for (let depth = 0; depth < 6; depth += 1) {
      try {
        const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
          name?: string
          version?: string
        }
        if (manifest.name === name && manifest.version) return `${name}@${manifest.version}`
      } catch {}
      directory = dirname(directory)
    }
  } catch {}
  return name
}

export const withEngine = async <T>(
  load: LoadEngine,
  name: Engine,
  read: (engine: T, extractor: string) => Promise<Extraction>,
): Promise<Extraction> => {
  let engine: T
  try {
    const loaded = (await load(name)) as T & { default?: T }
    engine = name === "mammoth" && loaded.default ? loaded.default : loaded
  } catch (error) {
    if (isMissing(error, name)) return { status: "engine-missing", engine: name }
    throw error
  }
  const extractor = `${name === "mammoth" ? "docx" : name === "word-extractor" ? "doc" : "pdf"}:${versionOf(name)}`
  try {
    return await read(engine, extractor)
  } catch (error) {
    if (error instanceof ReaderLimit) return { status: "too-large" }
    if (isCliError(error) && error.code === "cancelled") throw error
    // The engine's message may quote the file; only the fact that it failed is kept.
    return { status: "unreadable", extractor, error: "unreadable" }
  }
}

export const startsWith = (bytes: Uint8Array, magic: string) =>
  bytes.length >= magic.length && [...magic].every((char, index) => bytes[index] === char.charCodeAt(0))

export const extensionOf = ({ name, path }: FileHint) => extname(name ?? path).toLowerCase()

export const capped = (text: string) => (text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text)

/** Text read out of a markup, decoded as plain text is; an empty result is for the agent. */
export const derived = (bytes: Uint8Array, extractor: string, read: (source: string) => string): Extraction => {
  const decoded = decodeText(bytes)
  if ("error" in decoded) return { status: "unreadable", extractor, error: decoded.error }
  try {
    const text = read(decoded.text)
    return text === "" ? { status: "needs-agent", extractor } : { status: "extracted", text: capped(text), extractor }
  } catch (error) {
    if (error instanceof ReaderLimit) return { status: "too-large" }
    return { status: "unreadable", extractor, error: "invalid_document" }
  }
}
