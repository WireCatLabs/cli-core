import { existsSync, readFileSync } from "node:fs"
import { holdLock, type Lock, readLock, releaseLock, takeLock } from "../../background/lock.js"

export const ACCESS_SECONDS = 60 * 60
export const REFRESH_SECONDS = 30 * 24 * 60 * 60

export interface StoredClient {
  id: string
  name?: string
  secretHash?: string
  redirectUris: string[]
  authMethod: "none" | "client_secret_post" | "client_secret_basic"
  issuedAt: number
}

export interface StoredToken {
  hash: string
  kind: "access" | "refresh"
  clientId: string
  expiresAt: number
}

/** The token file: registered clients and the hashes of the tokens they hold. */
export interface Stored {
  clients: StoredClient[]
  tokens: StoredToken[]
}

export const readStored = (path: string): Stored =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Stored) : { clients: [], tokens: [] }

/** What a running `mcp --http` writes beside its token file, mode 600 — the login code is a live credential. */
export interface HttpLock extends Lock {
  port: number
  publicUrl: string
  loginCode?: string
  loginCodeExpiresAt?: string
}

/** The variable a server started by `mcp server start` carries; a serve's `<PREFIX>_SERVER` never ends with it. */
export const mcpHttpMarker = (envPrefix: string) => `${envPrefix}_MCP_HTTP`

export const httpLogFile = (tokenFile: string) => `${tokenFile.replace(/\.json$/, "")}.log`

/** Beside the token file, so each CLI's own layout decides both: `mcp-http/<profile>.json` → `.lock`. */
export const httpLockFile = (tokenFile: string) => `${tokenFile.replace(/\.json$/, "")}.lock`

export const readHttpLock = (path: string): HttpLock | undefined => {
  const lock = readLock(path) as Partial<HttpLock> | undefined
  return lock && typeof lock.port === "number" && typeof lock.publicUrl === "string" ? (lock as HttpLock) : undefined
}

/** The lock a serving process keeps current: taken before it listens, given up when it closes. */
export const httpLock = (path: string, first: HttpLock) => {
  let current = first
  const held = takeLock(path, current)
  return {
    held: held as HttpLock | undefined,
    update: (change: Partial<HttpLock>) => {
      current = { ...current, ...change }
      holdLock(path, current)
    },
    release: () => releaseLock(path),
  }
}

export interface SignedInClient {
  /** What the app said its name was when it registered — anyone may register, so it proves nothing. */
  claimedName: string | null
  lastLoginAt: string
}

/**
 * The apps that hold a token now, and when each last got one. Ids and hashes stay in the file: what
 * leaves is enough to recognise an app, never to act as it.
 */
export const signedInClients = (tokenFile: string, now = Date.now()): SignedInClient[] => {
  const seconds = Math.floor(now / 1000)
  const { clients, tokens } = readStored(tokenFile)
  const last = new Map<string, number>()
  for (const token of tokens) {
    if (token.expiresAt <= seconds) continue
    const issued = token.expiresAt - (token.kind === "access" ? ACCESS_SECONDS : REFRESH_SECONDS)
    last.set(token.clientId, Math.max(last.get(token.clientId) ?? 0, issued))
  }
  return clients
    .filter((client) => last.has(client.id))
    .map((client) => ({
      claimedName: client.name ?? null,
      lastLoginAt: new Date((last.get(client.id) ?? 0) * 1000).toISOString(),
    }))
    .sort((a, b) => b.lastLoginAt.localeCompare(a.lastLoginAt))
}
