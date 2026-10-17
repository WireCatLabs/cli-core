import { CliError } from "@wirecat/cli-base"
import {
  type ContextEvidenceReader,
  type ContextSource,
  contextEvidenceRequest,
  contextSource,
} from "../context/evidence.js"

/** The host supplies authorization; neither discovery nor absent selections expand it. */
export const createContextEvidenceReader = (
  port: ContextEvidenceReader,
  allowed: readonly ContextSource[],
): ContextEvidenceReader => {
  if (!port || typeof port.read !== "function")
    throw new CliError("configuration_error", "context evidence reader is unavailable")
  if (!Array.isArray(allowed) || !allowed.length || allowed.length > 32)
    throw new CliError("validation_error", "allowed needs 1–32 explicitly authorized sources")
  const key = (s: ContextSource) => JSON.stringify([s.kind, s.accountId, s.provider, s.account])
  const keys = new Set(allowed.map(contextSource).map(key))
  const read = port.read.bind(port)
  return {
    async read(original) {
      const validated = contextEvidenceRequest(original)
      const { source, signal } = validated
      if (!keys.has(key(source)))
        throw new CliError("validation_error", "source is outside the host's authorized selection")
      signal?.throwIfAborted()
      const page = await read({ ...original, source, cursor: validated.cursor })
      signal?.throwIfAborted()
      if (key(page.source) !== key(source))
        throw new CliError("validation_error", "context reader returned another source")
      if (page.items.some((item) => item.provider !== source.provider || item.account !== source.account))
        throw new CliError("validation_error", "context reader returned another account")
      return page
    },
  }
}

export type {
  ContextEvidenceItem,
  ContextEvidencePage,
  ContextEvidenceReader,
  ContextEvidenceRequest,
  ContextSource,
} from "../context/evidence.js"
