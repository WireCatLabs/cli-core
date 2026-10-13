// biome-ignore lint/style/noRestrictedImports: a type, and the shape an unreadable result carries for the commands
import type { ActionableError } from "../cli/recovery.js"
import type { Engine } from "./engine.js"

export type { Engine } from "./engine.js"

/** Loads a reader package; a test hands in its own to play a machine without it. */
export type LoadEngine = (name: Engine) => Promise<unknown>

export interface Section {
  heading: string
  level: number
  start: number
  end: number
}

export type Extraction =
  | {
      status: "extracted"
      text: string
      extractor: string
      pages?: number
      ocrPages?: number
      spans?: { page: number; start: number; end: number }[]
      metadata?: Record<string, string | string[]>
      sections?: Section[]
      truncated?: boolean
    }
  /** No text layer: a scan, a photo. An agent reads it and writes the text back. */
  | { status: "needs-agent"; extractor?: string }
  | { status: "unreadable"; extractor: string; error: string; issue?: ActionableError }
  | { status: "unsupported" }
  | { status: "engine-missing"; engine: Engine }
  | { status: "too-large" }

export interface FileHint {
  kind: string
  name: string | null
  mime: string | null
  path: string
}

export interface ReadContext {
  load: LoadEngine
  signal?: AbortSignal
}

export interface Reader {
  id: string
  version: string
  accepts(hint: FileHint, head: Uint8Array): boolean
  read(bytes: Uint8Array, hint: FileHint, context: ReadContext): Promise<Extraction>
}
