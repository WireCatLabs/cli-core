import { readFileSync } from "node:fs"
import { dirname, extname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { isCliError } from "@wirecat/cli-base"
import { ReaderLimit } from "../attachments/container.js"
import { decodeText } from "../attachments/encoding.js"
import { MAX_TEXT_CHARS } from "../attachments/limits.js"
import { EngineUnavailable } from "../engines/install.js"
import { ENGINE_PINS } from "../engines/pins.js"
import type { Extraction, FileHint, LoadEngine } from "./types.js"

/** The packages that read formats and ship with this package: small, and on the common path. */
export const BUILT_IN = ["word-extractor"] as const
/**
 * The PDF, web-page and HTML readers: installed into the WireCat data folder the first time a file needs one (the
 * owner's decision of 2026-11-26). Each names the engine that holds it; defuddle brings linkedom with it.
 */
export const FIRST_USE = { unpdf: "unpdf", linkedom: "defuddle", "defuddle/node": "defuddle" } as const
export const ENGINES = [
  ...BUILT_IN,
  ...(Object.keys(FIRST_USE) as (keyof typeof FIRST_USE)[]),
  "@napi-rs/canvas",
] as const
export type Engine = (typeof ENGINES)[number]

const isMissing = (error: unknown, name: Engine) =>
  (error as NodeJS.ErrnoException)?.code === "ERR_MODULE_NOT_FOUND" && String((error as Error).message).includes(name)

/** `name@version` from the pins for an engine installed on first use, else from the manifest beside the module. */
const versionOf = (name: Engine): string => {
  if (name in FIRST_USE) {
    const pkg = name.split("/")[0]
    const pinned = ENGINE_PINS[FIRST_USE[name as keyof typeof FIRST_USE]].packages.find((entry) => entry.name === pkg)
    return pinned ? `${pkg}@${pinned.version}` : name
  }
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
    engine = (await load(name)) as T
  } catch (error) {
    if (isMissing(error, name)) return { status: "engine-missing", engine: name }
    if (error instanceof EngineUnavailable) return engineUnavailable(name, error)
    throw error
  }
  const extractor = `${name === "word-extractor" ? "doc" : "pdf"}:${versionOf(name)}`
  return guarded(extractor, () => read(engine, extractor))
}

export const engineUnavailable = (engine: Engine, error: EngineUnavailable): Extraction => ({
  status: "engine-missing",
  engine,
  retry: error.state.retry,
  reason: error.state.reason,
})

/** A reader's failure as a result: a limit is `too-large`, anything else but a cancel is `unreadable`. */
export const guarded = async (extractor: string, read: () => Promise<Extraction>): Promise<Extraction> => {
  try {
    return await read()
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
