import { openAsBlob } from "node:fs"
import { CliError } from "@wirecat/cli-base"
import { DEFAULT_RESOURCE_LIMITS, type ResourceLimits } from "./resource-limits.js"

export type UploadSource = { kind: "bytes"; bytes: Uint8Array } | { kind: "file"; path: string; size: number }
export const uploadSize = (source: UploadSource): number =>
  source.kind === "bytes" ? source.bytes.byteLength : source.size
export const uploadBlob = async (source: UploadSource, type = "application/octet-stream"): Promise<Blob> => {
  const blob = source.kind === "bytes" ? new Blob([source.bytes], { type }) : await openAsBlob(source.path, { type })
  if (blob.size !== uploadSize(source))
    throw new CliError("validation_error", "upload changed since preparation — nothing was sent")
  return blob
}

export const validateUploadSources = (sources: readonly UploadSource[], limits: Partial<ResourceLimits> = {}): void => {
  validateUploadSizes(
    sources.map((source) => ({ size: uploadSize(source), buffered: source.kind === "bytes" })),
    limits,
  )
}

export const validateUploadSizes = (
  sources: readonly { size: number; buffered: boolean }[],
  limits: Partial<ResourceLimits> = {},
): void => {
  const budget = { ...DEFAULT_RESOURCE_LIMITS, ...limits }
  let total = 0
  let buffered = 0
  for (const source of sources) {
    const size = source.size
    if (!Number.isSafeInteger(size) || size < 0) throw new CliError("validation_error", "invalid upload size")
    total += size
    if (source.buffered) buffered += size
    if (budget.maxUploadBytes !== 0 && size > budget.maxUploadBytes)
      throw new CliError(
        "validation_error",
        `upload exceeds maxUploadBytes (${budget.maxUploadBytes}) — nothing was sent`,
      )
  }
  if (budget.maxUploadTotalBytes !== 0 && total > budget.maxUploadTotalBytes)
    throw new CliError(
      "validation_error",
      `uploads exceed maxUploadTotalBytes (${budget.maxUploadTotalBytes}) — nothing was sent`,
    )
  if (budget.maxBufferedUploadBytes !== 0 && buffered > budget.maxBufferedUploadBytes)
    throw new CliError(
      "validation_error",
      `uploads exceed maxBufferedUploadBytes (${budget.maxBufferedUploadBytes}) — nothing was sent`,
    )
}

export const uploadBytes = async (source: UploadSource, limits: Partial<ResourceLimits> = {}): Promise<Uint8Array> => {
  validateUploadSources([source], limits)
  const cap = limits.maxBufferedUploadBytes ?? DEFAULT_RESOURCE_LIMITS.maxBufferedUploadBytes
  if (cap !== 0 && uploadSize(source) > cap)
    throw new CliError("validation_error", `upload conversion exceeds maxBufferedUploadBytes (${cap})`)
  if (source.kind === "bytes") return source.bytes
  const blob = await uploadBlob(source)
  if (blob.size !== source.size)
    throw new CliError("validation_error", "upload changed since preparation — nothing was sent")
  const reader = blob.stream().getReader()
  const bytes = new Uint8Array(blob.size)
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if ((cap !== 0 && size > cap) || size > source.size)
        throw new CliError("validation_error", "upload exceeds its buffered size budget — nothing was sent")
      bytes.set(chunk.value, size - chunk.value.byteLength)
    }
  } finally {
    await reader.cancel()
  }
  if (size !== source.size)
    throw new CliError("validation_error", "upload ended before its prepared size — nothing was sent")
  return bytes
}
