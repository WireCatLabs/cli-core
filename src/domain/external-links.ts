import { CliError } from "@wirecat/cli-base"

/** The outside service an external id belongs to: `avito`, `cian`, `amazon`, `hh`. */
export const EXTERNAL_SERVICE = /^[a-z][a-z0-9-]{0,31}$/
export const EXTERNAL_ID_CHARS = 200
export const SOURCE_URL_CHARS = 2000

export interface ExternalId {
  provider: string
  id: string
}

/** `avito:4512345678` → the service and its id; the id is everything after the first colon. */
export const externalIdOf = (value: string): ExternalId => {
  const text = value.trim()
  const colon = text.indexOf(":")
  const provider = colon === -1 ? "" : text.slice(0, colon).toLowerCase()
  const id = colon === -1 ? "" : text.slice(colon + 1).trim()
  if (!EXTERNAL_SERVICE.test(provider) || id.length === 0 || id.length > EXTERNAL_ID_CHARS || /\s/.test(id))
    throw new CliError(
      "validation_error",
      `an external id is <service>:<id>, such as avito:4512345678, at most ${EXTERNAL_ID_CHARS} characters after the colon and no spaces, not "${value}"`,
      { reason: "task.external-id" },
    )
  return { provider, id }
}

export const externalIdText = (provider: unknown, id: unknown): string | null =>
  provider == null || id == null ? null : `${String(provider)}:${String(id)}`

/** An http or https address, as given; anything else is refused, so a stored link always opens a web page. */
export const sourceUrlOf = (value: string, reason = "task.source-url"): string => {
  const text = value.trim()
  let url: URL | undefined
  try {
    url = new URL(text)
  } catch {
    url = undefined
  }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || text.length > SOURCE_URL_CHARS)
    throw new CliError(
      "validation_error",
      `a source URL is an http or https address of at most ${SOURCE_URL_CHARS} characters, not "${value}"`,
      { reason },
    )
  return text
}
