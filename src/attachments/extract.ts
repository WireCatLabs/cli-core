import { extname } from "node:path"
import {
  type EnginePin,
  type EngineState,
  EngineUnavailable,
  ensureEngine,
  importFromEngine,
  isEngineInstalled,
  SAME_COMMAND_AGAIN,
} from "../engines/install.js"
import { ENGINE_PINS } from "../engines/pins.js"
import { BUILT_IN, ENGINES, FIRST_USE } from "../readers/engine.js"
import { IMAGES } from "../readers/image/index.js"
import { readWithRegistry } from "../readers/registry.js"
import type { Engine, Extraction, FileHint, LoadEngine } from "../readers/types.js"
import type { Fetch } from "../speech/install.js"
import { attachmentMaxBytes } from "./limits.js"

export { BUILT_IN, ENGINES, FIRST_USE } from "../readers/engine.js"
export type { Engine, Extraction, FileHint, LoadEngine } from "../readers/types.js"
export { MAX_FILE_BYTES, MAX_TEXT_CHARS } from "./limits.js"

const READER_RETRY = SAME_COMMAND_AGAIN

export interface EngineLoaderOptions {
  env?: NodeJS.ProcessEnv
  fetch?: Fetch
  /** The engines to install, by the names in `FIRST_USE`; a test hands in its own. */
  pins?: Readonly<Record<string, EnginePin>>
}

const isFirstUse = (name: Engine): name is keyof typeof FIRST_USE => name in FIRST_USE

/**
 * Loads a reader package: a built-in one from beside cli-core, a first-use one from the WireCat data folder, installed
 * there first with no question and no output, so `--json` and MCP stay clean. A failed install throws
 * `EngineUnavailable`, which the reader answers as `engine-missing`.
 */
export const engineLoader = (options: EngineLoaderOptions = {}): LoadEngine => {
  const installing = new Map<string, Promise<EngineState>>()
  return async (name) => {
    if (!isFirstUse(name)) return import(name)
    const engine = FIRST_USE[name]
    const pin = (options.pins ?? ENGINE_PINS)[engine]
    if (!pin) throw new Error(`no pin for the engine ${engine}`)
    let state = installing.get(engine)
    if (!state) {
      state = ensureEngine(pin, {
        retry: READER_RETRY,
        ...(options.env ? { env: options.env } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }).finally(() => installing.delete(engine))
      installing.set(engine, state)
    }
    const ready = await state
    if (ready.status !== "ready") throw new EngineUnavailable(ready)
    return importFromEngine(ready.folder, name)
  }
}

export const importEngine: LoadEngine = engineLoader()

const extensionOf = ({ name, path }: FileHint) => extname(name ?? path).toLowerCase()

/**
 * Only an exact text layer: plain text, a Word document, a PDF that carries its text. A photo, a scan
 * or a PDF of pictures is an agent's to read (the owner's decision: no OCR in the tool).
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
  "word-extractor": "Word 97–2003",
  linkedom: "HTML",
  "defuddle/node": "HTML",
  "@napi-rs/canvas": "Scanned PDF OCR",
}

const isBuiltIn = (engine: Engine) => (BUILT_IN as readonly string[]).includes(engine)

/** Why a file was not read for want of a package, and what fixes it. */
export const engineMissing = (engine: Engine): string =>
  isFirstUse(engine)
    ? `the reader ${engine} installs on first use and could not be installed now — run ${READER_RETRY}`
    : isBuiltIn(engine)
      ? `the package ${engine}, which ships with this tool, could not be loaded — reinstall the tool`
      : `the optional package ${engine} is needed, installed where this tool is (for a global npm install: npm install -g ${engine})`

/** The one note a run gives for a format it skipped, naming what to install. */
export const engineHint = (engine: Engine, command: string): string =>
  `${ENGINE_FILES[engine]} files: ${engineMissing(engine).replace("this tool", command)}; they are read on the next run`

export type ReaderState = "built in" | "installed" | "missing" | "on first use"

/** For `doctor`: each reader found exactly where `importEngine` would load it. */
export const engineStates = (
  resolve: (name: string) => string = (name) => import.meta.resolve(name),
  env: NodeJS.ProcessEnv = process.env,
): Record<Engine, ReaderState> =>
  Object.fromEntries(
    ENGINES.map((name) => {
      if (isFirstUse(name))
        return [name, isEngineInstalled(ENGINE_PINS[FIRST_USE[name]], env) ? "installed" : "on first use"]
      try {
        resolve(name)
        return [name, isBuiltIn(name) ? "built in" : "installed"]
      } catch {
        return [name, "missing"]
      }
    }),
  ) as Record<Engine, ReaderState>

export const tooLarge = (bytes: number, env: NodeJS.ProcessEnv = process.env): boolean =>
  bytes > attachmentMaxBytes(env)
