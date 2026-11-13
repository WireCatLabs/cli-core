import { CliError } from "@wirecat/cli-base"
import { statusToCode } from "@wirecat/cli-base/http"

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

const reasonsOf = (body: unknown): string[] => {
  const error = isRecord(body) ? body.error : undefined
  if (!isRecord(error)) return []
  return [
    ...(Array.isArray(error.errors) ? error.errors.map((item) => item?.reason) : []),
    ...(Array.isArray(error.details)
      ? error.details
          .filter((detail) => detail?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo")
          .map((detail) => detail.reason)
      : []),
    error.status,
  ].filter((reason): reason is string => typeof reason === "string")
}

const RATE = new Set(["rateLimitExceeded", "userRateLimitExceeded", "RESOURCE_EXHAUSTED"])

export interface GoogleFailure {
  status: number
  /** The answer's parsed JSON body, or anything else it held. */
  body: unknown
  /** The request may have changed something: a 5xx then has no certain outcome. */
  mutates: boolean
  retryAfterMs?: number | undefined
  /** The API as people know it, in messages: `Google Calendar`, `Google Meet`. `Google` when left out. */
  service?: string
  /** The API's errors guide, named when the usage limits are exceeded. */
  errorsGuide?: string
}

/**
 * A Google API refusal as a CliError, from the answer's status and body. Google's own message is never repeated: it
 * can quote the ids and text that were asked for (WC-SECR-6).
 */
export const googleError = ({
  status,
  body,
  mutates,
  retryAfterMs,
  service = "Google",
  errorsGuide,
}: GoogleFailure): CliError => {
  const reasons = reasonsOf(body)
  const wait = retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }
  if (status === 401)
    return new CliError("authentication_error", "Google sign-in expired", {
      reason: "oauth.expired",
      status,
    })
  if (reasons.some((reason) => reason === "accessNotConfigured" || reason === "SERVICE_DISABLED"))
    return new CliError(
      "configuration_error",
      `the ${service} API is turned off for this OAuth project; its owner turns it on in Google Cloud API Library`,
      { reason: "api.disabled", status },
    )
  if (reasons.some((reason) => reason === "insufficientPermissions" || reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT"))
    return new CliError("permission_error", "the sign-in lacks the Google permission this method needs", {
      reason: "oauth.scope-missing",
      status,
    })
  // Google answers it with the Workspace usage limits, not with a retry.
  if (reasons.includes("quotaExceeded"))
    return new CliError(
      "rate_limited",
      `${service} usage limits are exceeded for this account; wait before trying again` +
        (errorsGuide ? ` (${errorsGuide})` : ""),
      { reason: "provider.usage-limit", retryable: false, status },
    )
  if (reasons.includes("forbiddenForNonOrganizer"))
    return new CliError(
      "permission_error",
      "only the organizer can change this; change your own copy's fields only, such as your answer or reminders",
      { reason: "event.organizer-only", status },
    )
  if (status === 429 || reasons.some((reason) => RATE.has(reason)))
    // Google turned the request away before acting on it, so even a write is safe to send again.
    return new CliError("rate_limited", "Google rate limit reached; retry the command", {
      retryable: true,
      status,
      ...wait,
    })
  if (status >= 500)
    return mutates
      ? new CliError("outcome_unknown", "Google write has no certain outcome; check Google before repeating it", {
          retryable: false,
          status,
        })
      : new CliError(statusToCode(status), `${service} failed (HTTP ${status}); retry the command`, {
          retryable: true,
          status,
          ...wait,
        })
  if (status === 403)
    return new CliError("permission_error", `${service} denied this operation; check this account's access to it`, {
      reason: "access.denied",
      status,
    })
  if (status === 404)
    return new CliError("not_found", `${service} has no such item, or this account cannot see it`, {
      reason: "item.not-found",
      status,
    })
  return new CliError(statusToCode(status), `${service} refused the request (HTTP ${status})`, { status })
}
