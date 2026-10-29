import {
  CliError,
  type CredentialSource,
  Credentials,
  type CredentialsOptions,
  keyringService,
} from "@wirecat/cli-base"
import type { OAuthClient, TokenSet } from "./provider.js"

export interface StoredTokens {
  tokens: TokenSet
  /** The app the entry was signed in with, when the entry records it; refresh must use that one. */
  client?: OAuthClient
}

export interface EncodeInput {
  tokens: TokenSet
  client: OAuthClient
  /** The entry as stored before, so fields the codec does not own survive a write. */
  previous?: string
  /** Fields a CLI adds at sign-in, such as drive's `principal`. */
  extra?: Record<string, unknown>
}

/** Every failure throws a fixed message: a parser's message would quote the secret. */
export interface TokenCodec {
  decode(raw: string): StoredTokens
  encode(input: EncodeInput): string
}

export interface TokenStorage {
  /** Names the entry across processes; the lock is keyed by it. */
  readonly key: string
  /** Throws when the entry cannot be saved, so a sign-in fails before the browser, not after consent. */
  probe(): void
  read(): StoredTokens | undefined
  write(input: Omit<EncodeInput, "previous">): void
  remove(): CredentialSource[]
}

const invalid = () =>
  new CliError("authentication_error", "the saved sign-in cannot be read; sign in again", { reason: "oauth.invalid" })

const parse = (raw: string): Record<string, unknown> => {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw invalid()
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined)
const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined
const previousOf = (raw?: string): Record<string, unknown> => {
  if (raw === undefined) return {}
  try {
    return parse(raw)
  } catch {
    return {}
  }
}
const defined = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T

export const oauthAccount = (providerId: string, profile: string): string => {
  if (!profile.trim()) throw new CliError("validation_error", "name a profile: a sign-in always belongs to one")
  return `oauth:${providerId}:${profile}`
}

/** The entry every new sign-in writes: account `oauth:<provider>:<profile>` under the CLI's own service. */
export const standardCodec = (providerId: string): TokenCodec => ({
  decode: (raw) => {
    const value = parse(raw)
    const refreshToken = text(value.refreshToken)
    const clientId = text(value.clientId)
    if (value.version !== 1 || value.provider !== providerId || !refreshToken || !clientId) throw invalid()
    if (!Array.isArray(value.scopes) || !value.scopes.every((scope) => typeof scope === "string")) throw invalid()
    return {
      client: { clientId },
      tokens: defined({
        accessToken: text(value.accessToken),
        refreshToken,
        expiresAt: finite(value.expiresAt),
        scopes: value.scopes as string[],
        tokenType: text(value.tokenType),
      }),
    }
  },
  encode: ({ tokens, client, previous, extra }) =>
    JSON.stringify(
      defined({
        ...previousOf(previous),
        ...extra,
        version: 1,
        provider: providerId,
        clientId: client.clientId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        tokenType: tokens.tokenType,
      }),
    ),
})

/**
 * drive's entry as drive-cli writes it today: `{principal, clientId, clientSecret?, tokens: {access_token,
 * refresh_token, expiry_date, scope, token_type, …}}`. A write keeps every field it does not own.
 */
export const driveSessionCodec: TokenCodec = {
  decode: (raw) => {
    const value = parse(raw)
    const tokens = value.tokens
    if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) throw invalid()
    const fields = tokens as Record<string, unknown>
    const refreshToken = text(fields.refresh_token)
    const clientId = text(value.clientId)
    if (!refreshToken || !clientId || typeof value.principal !== "string") throw invalid()
    return {
      client: defined({ clientId, clientSecret: text(value.clientSecret) }),
      tokens: defined({
        accessToken: text(fields.access_token),
        refreshToken,
        expiresAt: finite(fields.expiry_date),
        scopes: typeof fields.scope === "string" ? fields.scope.split(/\s+/).filter(Boolean) : [],
        tokenType: text(fields.token_type),
      }),
    }
  },
  encode: ({ tokens, client, previous, extra }) => {
    const before = previousOf(previous)
    const oldTokens = typeof before.tokens === "object" && before.tokens !== null ? before.tokens : {}
    const session: Record<string, unknown> = {
      ...before,
      ...extra,
      clientId: client.clientId,
      ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
      tokens: defined({
        ...oldTokens,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expiry_date: tokens.expiresAt,
        ...(tokens.scopes.length ? { scope: tokens.scopes.join(" ") } : {}),
        token_type: tokens.tokenType,
      }),
    }
    if (typeof session.principal !== "string")
      throw new CliError("configuration_error", "drive's sign-in entry needs the account's principal")
    return JSON.stringify(session)
  },
}

/** zm's entry as zoom-cli writes it today: `{accessToken, refreshToken, expiresAt, scopes}`, all four required. */
export const zoomTokenCodec: TokenCodec = {
  decode: (raw) => {
    const value = parse(raw)
    const accessToken = text(value.accessToken)
    const refreshToken = text(value.refreshToken)
    const expiresAt = finite(value.expiresAt)
    if (!accessToken || !refreshToken || expiresAt === undefined) throw invalid()
    if (!Array.isArray(value.scopes) || !value.scopes.every((scope) => typeof scope === "string")) throw invalid()
    return { tokens: { accessToken, refreshToken, expiresAt, scopes: value.scopes as string[] } }
  },
  encode: ({ tokens }) => {
    if (!tokens.accessToken) throw new CliError("invalid_response", "zm's sign-in entry needs an access token")
    return JSON.stringify({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt ?? 0,
      scopes: tokens.scopes,
    })
  },
}

export interface CredentialStorageOptions {
  /** What the CLI passes `Credentials` today; the same options address the same entry. */
  credentials: CredentialsOptions
  account: string
  /** Older accounts read when `account` is empty; a hit is copied to `account` and left in place. */
  legacyAccounts?: readonly string[]
  codec: TokenCodec
}

// The keyring's own words go to `--debug` and the run record as the cause, never into the answer; a store that
// echoes what it was handed loses the secret from them first.
const keyringFailure = (thrown: unknown, secret?: string) => {
  const failure = new CliError(
    "configuration_error",
    "could not reach the saved sign-in; use an available keyring or file storage",
    { reason: "oauth.not-saved" },
  )
  const words = thrown instanceof Error ? thrown.message : String(thrown)
  failure.cause = new Error(secret ? words.replaceAll(secret, "[secret]") : words)
  return failure
}

export const credentialStorage = (options: CredentialStorageOptions): TokenStorage => {
  if (!options.credentials.keyring)
    throw new CliError("configuration_error", "a sign-in store needs its keyring passed in, never a default")
  const credentials = new Credentials(options.credentials)
  const { account, codec } = options
  const service = keyringService(
    options.credentials.service,
    options.credentials.configDir,
    options.credentials.isolated,
  )
  const raw = (name: string) => {
    try {
      return credentials.read(name)?.secret
    } catch (error) {
      throw keyringFailure(error)
    }
  }
  const save = (value: string) => {
    try {
      credentials.write(account, value)
    } catch (error) {
      throw keyringFailure(error, value)
    }
  }
  const current = () => {
    const own = raw(account)
    if (own !== undefined) return own
    for (const legacy of options.legacyAccounts ?? []) {
      const found = raw(legacy)
      if (found === undefined) continue
      codec.decode(found)
      save(found)
      return found
    }
    return undefined
  }
  return {
    key: `${service}\u0000${account}`,
    probe: () => {
      raw(account)
    },
    read: () => {
      const value = current()
      return value === undefined ? undefined : codec.decode(value)
    },
    write: (input) => save(codec.encode({ ...input, previous: raw(account) })),
    remove: () => {
      try {
        return credentials.remove(account)
      } catch (error) {
        throw keyringFailure(error)
      }
    },
  }
}
