import { extname } from "node:path"
import { BUILT_IN, ENGINES } from "../readers/engine.js"
import { IMAGES } from "../readers/image/index.js"
import { readWithRegistry } from "../readers/registry.js"
import type { Engine, Extraction, FileHint, LoadEngine } from "../readers/types.js"
import { attachmentMaxBytes } from "./limits.js"

export { BUILT_IN, ENGINES } from "../readers/engine.js"
export type { Engine, Extraction, FileHint, LoadEngine } from "../readers/types.js"
export { MAX_FILE_BYTES, MAX_TEXT_CHARS } from "./limits.js"

export const importEngine: LoadEngine = (name) => import(name)

const extensionOf = ({ name, path }: FileHint) => extname(name ?? path).toLowerCase()

/**
 * Only an exact text layer: plain text, a Word document, a PDF that carries its text. A photo, a scan
 * or a PDF of pictures is an agent's to read (owner, NEED-546: no OCR in the tool).
 */
export const extractText = async (
  bytes: Uint8Array,
  hint: FileHint,
  load: LoadEngine,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Extraction> => {
  if (bytes.byteLength > attachmentMaxBytes(env)) return { status: "too-large" }
  return readWithRegistry(bytes, hint, { load, signal })
}

const SILENT_KINDS = new Set(["voice", "audio", "video", "video_note", "sticker", "animation", "gif"])
const SILENT = new Set([".ogg", ".oga", ".opus", ".mp3", ".m4a", ".wav", ".mp4", ".mov", ".webm", ".mkv", ".tgs"])

/**
 * What a file is, from its kind, type and name alone, so a photo or a video is never read only to be
 * set aside. `undefined`: its bytes decide.
 */
export const classify = (hint: FileHint): "image" | "unsupported" | undefined => {
  const extension = extensionOf(hint)
  if (hint.kind === "photo" || hint.mime?.startsWith("image/") || IMAGES.has(extension)) return "image"
  if (
    SILENT_KINDS.has(hint.kind) ||
    hint.mime?.startsWith("audio/") ||
    hint.mime?.startsWith("video/") ||
    SILENT.has(extension)
  )
    return "unsupported"
  return undefined
}

const ENGINE_FILES: Record<Engine, string> = {
  unpdf: "PDF",
  mammoth: "Word",
  "word-extractor": "Word 97–2003",
  linkedom: "HTML",
  "defuddle/node": "HTML",
  "@napi-rs/canvas": "Scanned PDF OCR",
}

const isBuiltIn = (engine: Engine) => (BUILT_IN as readonly string[]).includes(engine)

/** Why a file was not read for want of a package, and what fixes it. */
export const engineMissing = (engine: Engine): string =>
  isBuiltIn(engine)
    ? `the package ${engine}, which ships with this tool, could not be loaded — reinstall the tool`
    : `the optional package ${engine} is needed, installed where this tool is (for a global npm install: npm install -g ${engine})`

/** The one note a run gives for a format it skipped, naming what to install. */
export const engineHint = (engine: Engine, command: string): string =>
  `${ENGINE_FILES[engine]} files: ${engineMissing(engine).replace("this tool", command)}; they are read on the next run`

/** For `doctor`: each reader resolved from here exactly as `importEngine` would load it. */
export const engineStates = (
  resolve: (name: string) => string = (name) => import.meta.resolve(name),
): Record<Engine, "built in" | "installed" | "missing"> =>
  Object.fromEntries(
    ENGINES.map((name) => {
      try {
        resolve(name)
        return [name, isBuiltIn(name) ? "built in" : "installed"]
      } catch {
        return [name, "missing"]
      }
    }),
  ) as Record<Engine, "built in" | "installed" | "missing">

export const tooLarge = (bytes: number, env: NodeJS.ProcessEnv = process.env): boolean =>
  bytes > attachmentMaxBytes(env)
