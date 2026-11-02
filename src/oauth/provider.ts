import type { Logger } from "@wirecat/cli-base"

/** The app identity a provider issued; an installed app's secret is public, not account access. */
export interface OAuthClient {
  clientId: string
  clientSecret?: string
}

export interface TokenSet {
  accessToken?: string
  refreshToken: string
  /** UTC milliseconds; unknown means "refresh before use". */
  expiresAt?: number
  scopes: string[]
  tokenType?: string
}

export interface RequestContext {
  fetch: typeof fetch
  client: OAuthClient
  now: () => number
  signal?: AbortSignal
  log?: Logger
  /** The command that signs in again, named in every failure that needs it. */
  signInCommand: string
}

export interface ExchangeContext extends RequestContext {
  /** The tokens being refreshed; absent for the first exchange. */
  previous?: TokenSet
}

/**
 * A provider as a CLI declares it. cli-core holds no provider's URLs or ids; every step may be replaced, and the
 * keeper still holds the lock and the storage around it.
 */
export interface OAuthProvider {
  /** A short word, part of new keyring account names: `google`, `zoom`. */
  id: string
  /** The name people know, used in messages: `Google`. */
  name: string
  authorizeUrl: string
  tokenUrl: string
  revokeUrl?: string
  client: OAuthClient
  /**
   * `loopback` sends the browser to `http://127.0.0.1:<port>/callback`, or to `http://localhost:<port>/callback` with
   * `host: "localhost"` (the listener then takes `127.0.0.1` and `::1`). `relay` sends it to a fixed page that
   * forwards to the loopback port, which it reads from `state` (`<port>.<random>`).
   */
  redirect: { kind: "loopback"; host?: "localhost" } | { kind: "relay"; url: string }
  authorizeParams?: Record<string, string>
  exchange?: (params: Record<string, string>, context: ExchangeContext) => Promise<TokenSet>
  revoke?: (tokens: TokenSet, context: RequestContext) => Promise<void>
}
