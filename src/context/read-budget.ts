import { CliError } from "@wirecat/cli-base"

export interface ContextReadLimits {
  maxTotalReadBytes?: number
  maxReads?: number
}
export interface ContextReadUsage {
  reads: number
  chargedBytes: number
  reservedBytes: number
  remainingBytes: number
}

export const contextReadBudget = (limits: ContextReadLimits = {}) => {
  if (!limits || typeof limits !== "object" || Array.isArray(limits))
    throw new CliError("validation_error", "limits needs a context read allowance")
  for (const key of Object.keys(limits))
    if (!["maxTotalReadBytes", "maxReads"].includes(key))
      throw new CliError("validation_error", `limits.${key} is not supported`)
  const maxTotalReadBytes = limits.maxTotalReadBytes ?? 524288
  const maxReads = limits.maxReads ?? 16
  for (const [name, value, max] of [
    ["maxTotalReadBytes", maxTotalReadBytes, 4194304],
    ["maxReads", maxReads, 24],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new CliError("validation_error", `${name} must be a whole number from 1 to ${max}`)
  let reads = 0,
    chargedBytes = 0,
    reservedBytes = 0
  const usage = (): ContextReadUsage => ({
    reads,
    chargedBytes,
    reservedBytes,
    remainingBytes: maxTotalReadBytes - chargedBytes - reservedBytes,
  })
  return {
    usage,
    reserve(requested: number) {
      if (!Number.isSafeInteger(requested) || requested < 1 || requested > 1048576)
        throw new CliError("validation_error", "read reservation needs 1–1048576 bytes")
      const bytes = Math.min(requested, usage().remainingBytes)
      if (reads >= maxReads || bytes < 1)
        throw new CliError("validation_error", "context read allowance is exhausted", { reason: "context.read-budget" })
      reads++
      reservedBytes += bytes
      let finished = false
      const settle = (charged: number) => {
        if (finished) throw new Error("Context reservation already settled")
        finished = true
        reservedBytes -= bytes
        chargedBytes += charged
      }
      return {
        bytes,
        complete: (used: number) => {
          if (!Number.isSafeInteger(used) || used < 0 || used > bytes)
            throw new CliError("invalid_response", "context reader reported invalid charged bytes")
          settle(used)
        },
        fail: () => settle(bytes),
      }
    },
  }
}
