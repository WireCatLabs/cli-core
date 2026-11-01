import { createHash } from "node:crypto"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { CliError, type CredentialSource, isCliError, type Logger } from "@wirecat/cli-base"
import { acquireLock } from "../files/index.js"
import { type AuthorizeOptions, authorize } from "./authorize.js"
import type { ExchangeContext, OAuthClient, OAuthProvider, TokenSet } from "./provider.js"
import { requestTokens, revokeToken, TOKEN_LOG_EVENT } from "./requests.js"
import type { StoredTokens, TokenStorage } from "./storage.js"

export interface TokenKeeperOptions {
  provider: OAuthProvider
  storage: TokenStorage
  /** The CLI's config directory: the keyring entry varies with it, so the lock must too. */
  lockDir: string
  fetch: typeof fetch
  /** `drive personal session start`: named in every failure that needs a new sign-in. */
  signInCommand: string
  now?: () => number
  signal?: AbortSignal
  log?: Logger
  /** Longer than one token request's 30 s limit, so a live refresher finishes first. Real time, not `now`. */
  lockWaitMs?: number
  lockRetryMs?: number
  /** An access token expiring later than this from now is used as is. */
  freshForMs?: number
}

export type SignInOptions = Omit<AuthorizeOptions, "provider" | "signal"> & {
  /** Runs before anything is saved; it may refuse the account or add fields to the entry (drive's `principal`). */
  accept?: (tokens: TokenSet) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined
}

export interface TokensOptions {
  /**
   * The server refused the access token this keeper last answered, though `expiresAt` called it fresh (a revoked
   * session): refresh under the lock anyway, unless another process already saved a different fresh one.
   */
  refresh?: boolean
}

export interface TokenKeeper {
  accessToken(options?: TokensOptions): Promise<string>
  tokens(options?: TokensOptions): Promise<TokenSet>
  signIn(options: SignInOptions): Promise<{ scopes: string[] }>
  /** Saves tokens a CLI got by a flow of its own, under the same lock. */
  save(tokens: TokenSet, extra?: Record<string, unknown>): Promise<void>
  signOut(options?: { revoke?: boolean }): Promise<{ revoked: boolean; removed: CredentialSource[] }>
}

const inFlight = new Map<string, Promise<unknown>>()
const refreshedInMemory = new Map<string, TokenSet>()

export const tokenKeeper = (options: TokenKeeperOptions): TokenKeeper => {
  const { provider, storage, signal, log } = options
  const now = options.now ?? Date.now
  const fresh = (tokens: TokenSet) =>
    Boolean(tokens.accessToken) &&
    tokens.expiresAt !== undefined &&
    tokens.expiresAt > now() + (options.freshForMs ?? 60_000)
  const lockPath = join(
    options.lockDir,
    `oauth-${createHash("sha256").update(storage.key).digest("hex").slice(0, 16)}.lock`,
  )
  const clientOf = (stored?: StoredTokens): OAuthClient => {
    const saved = stored?.client
    if (!saved || saved.clientSecret || saved.clientId !== provider.client.clientId) return saved ?? provider.client
    return provider.client
  }
  const context = (client: OAuthClient, previous?: TokenSet): ExchangeContext => ({
    fetch: options.fetch,
    client,
    now,
    signInCommand: options.signInCommand,
    ...(signal ? { signal } : {}),
    ...(log ? { log } : {}),
    ...(previous ? { previous } : {}),
  })
  const exchange = (params: Record<string, string>, ctx: ExchangeContext) =>
    provider.exchange ? provider.exchange(params, ctx) : requestTokens(provider, params, ctx)
  const notSignedIn = () =>
    new CliError("authentication_error", `not signed in to ${provider.name}; run ${options.signInCommand}`, {
      reason: "oauth.missing",
    })

  const busy = (error: unknown) => isCliError(error) && error.details.reason === "file.locked"
  const acquire = async () => {
    const started = performance.now()
    let waiting = false
    for (;;) {
      try {
        return await acquireLock(lockPath, signal ? { signal } : {})
      } catch (error) {
        if (!busy(error)) throw error
        if (!waiting) {
          waiting = true
          log?.info({
            event: TOKEN_LOG_EVENT,
            provider: provider.id,
            operation: "lock",
            outcome: "waiting",
            pid: process.pid,
          })
        }
        if (performance.now() - started > (options.lockWaitMs ?? 45_000))
          throw new CliError("provider_unavailable", `another process holds this ${provider.name} sign-in; retry`, {
            reason: "oauth.locked",
            retryable: true,
          })
        await delay(options.lockRetryMs ?? 50, undefined, signal ? { signal } : {}).catch(() => {
          throw new CliError("cancelled", `${provider.name} sign-in was cancelled`)
        })
      }
    }
  }
  const locked = async <T>(work: () => Promise<T>): Promise<T> => {
    const lock = await acquire()
    try {
      return await work()
    } finally {
      await lock.release().catch(() => {})
    }
  }
  const shared = <T>(work: () => Promise<T>): Promise<T> => {
    const running = inFlight.get(lockPath) as Promise<T> | undefined
    if (running) return running
    const started = locked(work).finally(() => inFlight.delete(lockPath))
    inFlight.set(lockPath, started)
    return started
  }

  const remembered = (saved: TokenSet) => {
    const kept = refreshedInMemory.get(lockPath)
    return kept && fresh(kept) && kept.refreshToken === saved.refreshToken ? kept : undefined
  }
  const forget = () => refreshedInMemory.delete(lockPath)

  let answered: TokenSet | undefined
  const answer = (given: TokenSet) => {
    answered = given
    return given
  }
  const tokens = async ({ refresh = false }: TokensOptions = {}): Promise<TokenSet> => {
    const seen = storage.read()
    if (!seen) throw notSignedIn()
    if (!refresh) {
      const kept = remembered(seen.tokens)
      if (kept) return answer(kept)
      if (fresh(seen.tokens)) return answer(seen.tokens)
    }
    const refused = answered ?? remembered(seen.tokens) ?? seen.tokens
    return answer(
      await shared(async () => {
        const current = storage.read()
        if (!current) throw notSignedIn()
        const latest = remembered(current.tokens) ?? current.tokens
        // Another process refreshed while this one waited for the lock: its result is the one to use.
        if (refresh) {
          if (latest.accessToken !== refused.accessToken && fresh(latest)) return latest
        } else {
          if (latest !== current.tokens) return latest
          if (fresh(current.tokens) || current.tokens.refreshToken !== seen.tokens.refreshToken) return current.tokens
        }
        const client = clientOf(current)
        const refreshed = await exchange(
          { grant_type: "refresh_token", refresh_token: current.tokens.refreshToken },
          context(client, current.tokens),
        )
        // A rotated refresh token is saved even so: kept only in memory, it would die with the process.
        if (storage.moved && refreshed.refreshToken === current.tokens.refreshToken)
          refreshedInMemory.set(lockPath, refreshed)
        else storage.write({ tokens: refreshed, client })
        return refreshed
      }),
    )
  }

  return {
    tokens,
    accessToken: async (tokensOptions) => {
      const current = await tokens(tokensOptions)
      if (!current.accessToken) throw notSignedIn()
      return current.accessToken
    },
    signIn: async ({ accept, ...authorizeOptions }) => {
      storage.probe()
      const authorization = await authorize({ ...authorizeOptions, provider, ...(signal ? { signal } : {}) })
      const client = provider.client
      const received = await exchange(
        {
          grant_type: "authorization_code",
          code: authorization.code,
          redirect_uri: authorization.redirectUri,
          code_verifier: authorization.codeVerifier,
        },
        context(client),
      )
      const extra = (await accept?.(received)) ?? undefined
      await locked(async () => {
        forget()
        storage.write({ tokens: received, client, ...(extra ? { extra } : {}) }, { signIn: true })
      })
      return { scopes: received.scopes }
    },
    save: (saved, extra) =>
      locked(async () => {
        forget()
        storage.write(
          { tokens: saved, client: clientOf(storage.read()), ...(extra ? { extra } : {}) },
          { signIn: true },
        )
      }),
    signOut: ({ revoke = false } = {}) =>
      locked(async () => {
        forget()
        const current = storage.read()
        let revoked = false
        if (revoke && current) {
          await revokeToken(provider, current.tokens, context(clientOf(current)))
          revoked = true
        }
        return { revoked, removed: storage.remove() }
      }),
  }
}
