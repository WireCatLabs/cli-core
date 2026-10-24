import { CliError, isCliError } from "@wirecat/cli-base"
import type { ExchangeContext, OAuthProvider, RequestContext, TokenSet } from "./provider.js"

const REQUEST_LIMIT_MS = 30_000
export const TOKEN_LOG_EVENT = "oauth.token"
/** The keys the module's log records carry, for a run log's `allow`; names only, never a token. */
export const TOKEN_LOG_ALLOW = ["provider", "operation", "outcome", "status", "rotated", "pid"] as const

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object")
  return value as Record<string, unknown>
}

const requestSignal = (signal?: AbortSignal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_LIMIT_MS)]) : AbortSignal.timeout(REQUEST_LIMIT_MS)

const cancelledBy = (signal?: AbortSignal) => {
  if (!signal?.aborted) return
  throw isCliError(signal.reason) ? signal.reason : new CliError("cancelled", "sign-in was cancelled")
}

const post = async (url: string, body: URLSearchParams, context: RequestContext) => {
  cancelledBy(context.signal)
  try {
    return await context.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: requestSignal(context.signal),
      redirect: "error",
    })
  } catch {
    cancelledBy(context.signal)
    return undefined
  }
}

const clientFields = ({ client }: RequestContext): Record<string, string> => ({
  client_id: client.clientId,
  ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
})

/**
 * The token endpoint, form-encoded, for both grants. Nothing from the request or the response reaches a message or
 * a log record: both carry codes and tokens.
 */
export const requestTokens = async (
  provider: OAuthProvider,
  params: Record<string, string>,
  context: ExchangeContext,
): Promise<TokenSet> => {
  const operation = params.grant_type ?? "unknown"
  const record = (level: "info" | "warn" | "error", fields: Record<string, unknown>) =>
    context.log?.[level]({ event: TOKEN_LOG_EVENT, provider: provider.id, operation, pid: process.pid, ...fields })
  const again = `run ${context.signInCommand} again`
  const response = await post(provider.tokenUrl, new URLSearchParams({ ...params, ...clientFields(context) }), context)
  if (!response) {
    record("warn", { outcome: "no_response" })
    throw new CliError(
      "outcome_unknown",
      `${provider.name} token request did not finish; ${again} if it keeps failing`,
      {
        reason: "oauth.no-response",
      },
    )
  }
  if (!response.ok) {
    record("warn", { outcome: "rejected", status: response.status })
    if (response.status === 429 || response.status >= 500)
      throw new CliError("provider_unavailable", `${provider.name} token request failed (HTTP ${response.status})`, {
        status: response.status,
        retryable: true,
        reason: "oauth.unavailable",
      })
    throw new CliError(
      "authentication_error",
      `${provider.name} sign-in was refused (HTTP ${response.status}); ${again}`,
      {
        status: response.status,
        reason: "oauth.expired",
      },
    )
  }
  let body: Record<string, unknown>
  try {
    body = object(await response.json())
  } catch {
    record("error", { outcome: "unreadable_response", status: response.status })
    throw new CliError("invalid_response", `${provider.name} returned an unreadable token response; ${again}`, {
      reason: "oauth.invalid-response",
    })
  }
  const previous = context.previous
  const refreshToken =
    typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : previous?.refreshToken
  const expiresIn = body.expires_in
  if (
    typeof body.access_token !== "string" ||
    !body.access_token ||
    (expiresIn !== undefined && (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0)) ||
    (body.scope !== undefined && typeof body.scope !== "string") ||
    (body.token_type !== undefined && typeof body.token_type !== "string")
  ) {
    record("error", { outcome: "invalid_response", status: response.status })
    throw new CliError("invalid_response", `${provider.name} returned an invalid token response; ${again}`, {
      reason: "oauth.invalid-response",
    })
  }
  if (!refreshToken) {
    record("error", { outcome: "no_refresh_token", status: response.status })
    throw new CliError("authentication_error", `${provider.name} returned no offline refresh token; ${again}`, {
      reason: "oauth.failed",
    })
  }
  const scopes = typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : (previous?.scopes ?? [])
  const tokenType = typeof body.token_type === "string" ? body.token_type : previous?.tokenType
  record("info", {
    outcome: "received",
    status: response.status,
    ...(previous ? { rotated: refreshToken !== previous.refreshToken } : {}),
  })
  return {
    accessToken: body.access_token,
    refreshToken,
    ...(typeof expiresIn === "number" ? { expiresAt: context.now() + expiresIn * 1000 } : {}),
    scopes,
    ...(tokenType ? { tokenType } : {}),
  }
}

/** Revokes the refresh token at `revokeUrl`. A provider without one, or with another method, declares `revoke`. */
export const revokeToken = async (
  provider: OAuthProvider,
  tokens: TokenSet,
  context: RequestContext,
): Promise<void> => {
  if (provider.revoke) return provider.revoke(tokens, context)
  if (!provider.revokeUrl)
    throw new CliError("validation_error", `${provider.name} declares no way to revoke a sign-in`)
  const response = await post(
    provider.revokeUrl,
    new URLSearchParams({ token: tokens.refreshToken, ...clientFields(context) }),
    context,
  )
  context.log?.[response?.ok ? "info" : "warn"]({
    event: TOKEN_LOG_EVENT,
    provider: provider.id,
    operation: "revoke",
    pid: process.pid,
    outcome: response?.ok ? "revoked" : response ? "rejected" : "no_response",
    ...(response ? { status: response.status } : {}),
  })
  if (!response?.ok)
    throw new CliError("outcome_unknown", `${provider.name} did not confirm the revoke`, {
      reason: "oauth.revoke-failed",
      ...(response ? { status: response.status } : {}),
    })
}
