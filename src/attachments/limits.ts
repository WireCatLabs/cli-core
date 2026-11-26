import { type FileHandle, open } from "node:fs/promises"
import { CliError } from "@wirecat/cli-base"

export const MAX_FILE_BYTES = 10 * 1024 ** 3
export const MAX_TEXT_CHARS = 2_000_000
export const ATTACHMENT_LIMIT_ENV = [
  "MESSAGING_BATCH_MAX_ERROR_PERCENT",
  "MESSAGING_ATTACHMENT_MAX_MIB",
  "MESSAGING_PDF_PREVIEW_MAX_PIXELS",
  "MESSAGING_PDF_PREVIEW_MAX_MIB",
] as const

const positive = (env: NodeJS.ProcessEnv, name: string, fallback: number, factor = 1): number => {
  const raw = env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!/^[0-9]+$/.test(raw) || value < 1 || !Number.isSafeInteger(value * factor))
    throw new CliError("validation_error", `${name} must be a positive whole number within the safe numeric range`)
  return value * factor
}

export const attachmentMaxBytes = (env: NodeJS.ProcessEnv = process.env): number =>
  positive(env, "MESSAGING_ATTACHMENT_MAX_MIB", MAX_FILE_BYTES, 1024 * 1024)

/**
 * `readFile` stops at 2 GiB and the file budget goes past it, so the file is read in chunks into one buffer. The buffer
 * is its own, never a slice of Node's pool, so a caller keeps it without a copy.
 */
export const readWhole = async (file: string | FileHandle, signal?: AbortSignal): Promise<Buffer> => {
  const handle = typeof file === "string" ? await open(file, "r") : file
  try {
    const { size } = await handle.stat()
    const bytes = Buffer.allocUnsafeSlow(size)
    let offset = 0
    while (offset < size) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(bytes, offset, Math.min(size - offset, 64 * 1024 * 1024), offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return offset === size ? bytes : bytes.subarray(0, offset)
  } finally {
    if (typeof file === "string") await handle.close()
  }
}

/** The same bytes as a plain `Uint8Array`, whose `slice` copies as callers expect, without copying them. */
export const asBytes = (buffer: Buffer): Uint8Array =>
  new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)

/** A byte budget as people read it: `10 GiB`, `250 MiB`. */
export const sizeText = (bytes: number): string =>
  bytes % 1024 ** 3 === 0 ? `${bytes / 1024 ** 3} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`

export const pdfPreviewLimits = (env: NodeJS.ProcessEnv = process.env) => {
  const pixels = positive(env, "MESSAGING_PDF_PREVIEW_MAX_PIXELS", 4000)
  if (!Number.isSafeInteger(pixels * pixels))
    throw new CliError("validation_error", "MESSAGING_PDF_PREVIEW_MAX_PIXELS squared must fit the safe numeric range")
  return { pixels, bytes: positive(env, "MESSAGING_PDF_PREVIEW_MAX_MIB", 8 * 1024 * 1024, 1024 * 1024) }
}
