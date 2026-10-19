import { CliError } from "@wirecat/cli-base"
import {
  type ContextEvidenceReader,
  type ContextSource,
  contextEvidenceRequest,
  contextSource,
} from "../context/evidence.js"
import { contextSourceKey, validateContextEvidencePage } from "../context/evidence-response.js"
import { type ContextReadLimits, type ContextReadUsage, contextReadBudget } from "../context/read-budget.js"

/** The host supplies authorization; neither discovery nor absent selections expand it. */
export interface ScopedContextEvidenceReader extends ContextEvidenceReader {
  usage(): ContextReadUsage
}

export const createContextEvidenceReader = (
  port: ContextEvidenceReader,
  allowed: readonly ContextSource[],
  limits?: ContextReadLimits,
): ScopedContextEvidenceReader => {
  if (!port || typeof port.read !== "function")
    throw new CliError("configuration_error", "context evidence reader is unavailable")
  if (!Array.isArray(allowed) || !allowed.length || allowed.length > 8)
    throw new CliError("validation_error", "allowed needs 1–8 explicitly authorized sources")
  const keys = new Set(allowed.map(contextSource).map(contextSourceKey))
  const budget = contextReadBudget(limits)
  const read = port.read.bind(port)
  return {
    usage: budget.usage,
    async read(original) {
      const validated = contextEvidenceRequest(original)
      const { source, signal } = validated
      if (!keys.has(contextSourceKey(source)))
        throw new CliError("validation_error", "source is outside the host's authorized selection")
      signal?.throwIfAborted()
      const reservation = budget.reserve(validated.maxReadBytes)
      const request = Object.freeze({
        source: Object.freeze({ ...source }),
        query: validated.query,
        after: validated.after,
        before: validated.before,
        limit: validated.limit,
        maxReadBytes: reservation.bytes,
        cursor: validated.cursor ? Object.freeze({ ...validated.cursor }) : undefined,
        signal,
      })
      try {
        const page = await read(request)
        signal?.throwIfAborted()
        validateContextEvidencePage(page, request)
        reservation.complete(page.readBytes)
        return page
      } catch (error) {
        reservation.fail()
        throw error
      }
    },
  }
}

export type {
  ContextEvidenceItem,
  ContextEvidencePage,
  ContextEvidenceReader,
  ContextEvidenceRequest,
  ContextIndex,
  ContextRecordReader,
  ContextSource,
} from "../context/evidence.js"
export { contextEvidenceFingerprint } from "../context/evidence.js"
export type { ContextReadLimits, ContextReadUsage } from "../context/read-budget.js"
