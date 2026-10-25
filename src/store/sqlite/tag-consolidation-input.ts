import { CliError } from "@wirecat/cli-base"
import type { TagConsolidationApplyOptions, TagConsolidationOptions } from "../../domain/tag-consolidation.js"

export const consolidationId = (value: unknown, field: string): number => {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new CliError("validation_error", `${field} must be a positive canonical tag id`)
  return Number(value)
}

const bounded = (value: number, max: number, field: string) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new CliError("validation_error", `${field} must be an integer from 1 to ${max}`)
  return value
}

export const consolidationInput = (options: TagConsolidationOptions, apply = false) => {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new CliError("validation_error", "consolidation options are required")
  const allowed = new Set([
    "sourceId",
    "survivorId",
    "expectedVocabularyFingerprint",
    "maxRows",
    "maxReadBytes",
    "signal",
    ...(apply ? ["by", "expectedPreviewFingerprint", "idempotencyKey"] : ["sampleLimit"]),
  ])
  for (const field of Object.keys(options))
    if (!allowed.has(field)) throw new CliError("validation_error", `unknown consolidation field: ${field}`)
  const source = consolidationId(options.sourceId, "sourceId")
  const survivor = consolidationId(options.survivorId, "survivorId")
  if (source === survivor) throw new CliError("validation_error", "sourceId and survivorId must differ")
  if (
    typeof options.expectedVocabularyFingerprint !== "string" ||
    !/^v1:all:all:[a-f0-9]{64}$/.test(options.expectedVocabularyFingerprint)
  )
    throw new CliError(
      "validation_error",
      "expectedVocabularyFingerprint must come from a complete unfiltered vocabulary preview",
    )
  return {
    source,
    survivor,
    maxRows: bounded(options.maxRows ?? 5000, 20000, "maxRows"),
    maxReadBytes: bounded(options.maxReadBytes ?? 1024 * 1024, 16 * 1024 * 1024, "maxReadBytes"),
    limit: apply ? 1 : bounded(options.sampleLimit ?? 10, 100, "sampleLimit"),
  }
}

export const consolidationApplyInput = (options: TagConsolidationApplyOptions) => {
  const input = consolidationInput(options, true)
  if (options.by !== "owner")
    throw new CliError("permission_error", "only the owner applies a reviewed tag consolidation")
  if (
    typeof options.expectedPreviewFingerprint !== "string" ||
    !/^tag-preview-v1:[a-f0-9]{64}$/.test(options.expectedPreviewFingerprint)
  )
    throw new CliError("validation_error", "expectedPreviewFingerprint must come from a tag consolidation preview")
  if (typeof options.idempotencyKey !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(options.idempotencyKey))
    throw new CliError("validation_error", "idempotencyKey must be 1–128 ASCII identifier characters")
  return input
}
