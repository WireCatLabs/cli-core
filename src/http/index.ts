/**
 * The HTTP layer, deliberately behind its own entry point.
 *
 * A CLI that speaks a socket, a message bus or a local database has no business depending on
 * status-code semantics and `Retry-After` parsing. Import `@wirecat/cli-core/http` only when
 * the thing on the other end is actually HTTP.
 */
import type { ErrorCode } from "../errors.js"
import type { WallClock } from "../time.js"

/** The one function an HTTP client needs from its environment. A Worker, a browser, a test and Node all satisfy it. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** `Retry-After` is either a number of seconds or an HTTP date. Both forms occur in the wild. */
export const parseRetryAfter = (header: string | null | undefined, now: WallClock): number | undefined => {
  if (!header) return undefined

  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000

  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return undefined

  const delta = at - now().getTime()
  // A date already in the past would otherwise become a zero wait, and a zero wait against a rate
  // limit is a hot loop.
  return delta > 0 ? delta : undefined
}

/** A Unix timestamp in seconds, the shape several providers use for `X-RateLimit-Reset`. */
export const parseRateLimitReset = (header: string | null | undefined, now: WallClock): number | undefined => {
  if (!header) return undefined

  const seconds = Number(header.trim())
  if (!Number.isFinite(seconds)) return undefined

  const delta = seconds * 1000 - now().getTime()
  return delta > 0 ? delta : undefined
}

/** What the provider asked us to wait, if it asked at all. Its timing beats our own backoff. */
export const providerWaitMs = (headers: Headers, now: WallClock): number | undefined =>
  parseRetryAfter(headers.get("retry-after"), now) ?? parseRateLimitReset(headers.get("x-ratelimit-reset"), now)

export const retryableStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500

export const statusToCode = (status: number): ErrorCode => {
  if (status === 400 || status === 422) return "validation_error"
  if (status === 401) return "authentication_error"
  if (status === 403) return "permission_error"
  if (status === 404) return "not_found"
  if (status === 408) return "timeout"
  if (status === 429) return "rate_limited"
  if (status === 502 || status === 503 || status === 504) return "provider_unavailable"
  return "provider_error"
}
