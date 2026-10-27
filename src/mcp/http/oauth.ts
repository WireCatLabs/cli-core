import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto"
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server"
import { ACCESS_SECONDS, type StoredClient as Client, REFRESH_SECONDS, readStored, type Stored } from "./state.js"

const AUTH_CODE_MS = 60 * 1000
const LOGIN_CODE_MS = 10 * 60 * 1000
const WRONG_TRIES = 5
const WRONG_CODE_WAIT_MS = 30_000
const MAX_CLIENTS = 10
// biome-ignore lint/security/noSecrets: pairing-code alphabet, not a key
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

type AuthMethod = Client["authMethod"]

interface AuthCode {
  clientId: string
  redirectUri: string
  challenge: string
  expires: number
}

const hash = (value: string) => createHash("sha256").update(value).digest("base64url")
const secret = () => randomBytes(32).toString("base64url")
const same = (given: string, expected: string) => {
  const left = Buffer.from(given)
  const right = Buffer.from(expected)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

/** Only hashes reach the disk: the file is worth nothing to someone who copies it. */
const tokenFile = (path: string) => ({
  read: (): Stored => readStored(path),
  write: (stored: Stored) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`
    writeFileSync(temporary, JSON.stringify(stored), { mode: 0o600, flag: "wx" })
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
  },
})

export const revokeAll = (path: string) => rmSync(path, { force: true })

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })

const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status)

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)

const redirectAllowed = (uri: string): boolean => {
  try {
    const url = new URL(uri)
    if (url.hash) return false
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
  } catch {
    return false
  }
}

export interface OwnerLogin {
  /** The one-time code the owner types on the consent page; a new one after each login. */
  code(): string
  metadata: OAuthMetadata
  verifier: OAuthTokenVerifier
  /** Answers the login routes; `undefined` for any other path. `path` is the request's, as the public sees it. */
  handle(request: Request, path?: string): Promise<Response | undefined>
  close(): void
}

/**
 * An OAuth 2.1 authorization server for exactly one owner (CLI-58). Anyone may register a client —
 * the browser apps need dynamic registration — but nobody gets a token without the one-time code
 * printed in the owner's terminal. Five wrong codes delay further attempts for thirty seconds.
 */
export const ownerLogin = ({
  issuer,
  resource,
  file,
  appName,
  onCode,
  now = () => Date.now(),
}: {
  issuer: URL
  resource: URL
  file: string
  appName: string
  /** The code for the next login, for the owner's eyes only: their terminal, or the server's status file. */
  onCode: (code: string, expires: Date) => void
  now?: () => number
}): OwnerLogin => {
  const store = tokenFile(file)
  const codes = new Map<string, AuthCode>()
  let login = { value: "", expires: 0 }
  let wrong = 0
  let retryAt = 0

  let renewal: NodeJS.Timeout | undefined
  // Renewed when it runs out, not only when someone tries it: a code read from the status file must still work.
  const freshCode = () => {
    const part = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("")
    login = { value: `${part()}-${part()}`, expires: now() + LOGIN_CODE_MS }
    clearTimeout(renewal)
    renewal = setTimeout(freshCode, LOGIN_CODE_MS)
    renewal.unref()
    onCode(login.value, new Date(login.expires))
  }
  freshCode()

  // An issuer under a path, `https://name.ts.net/tg`, keeps its login routes under it too.
  const base = issuer.pathname.replace(/\/+$/, "")
  const endpoint = (path: string) => new URL(`${base}${path}`, issuer.origin).href
  const metadata: OAuthMetadata = {
    issuer: issuer.href,
    authorization_endpoint: endpoint("/authorize"),
    token_endpoint: endpoint("/token"),
    registration_endpoint: endpoint("/register"),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
  }

  const issue = (stored: Stored, clientId: string) => {
    const access = secret()
    const refresh = secret()
    const seconds = Math.floor(now() / 1000)
    stored.tokens = stored.tokens.filter((one) => one.expiresAt > seconds)
    stored.tokens.push(
      { hash: hash(access), kind: "access", clientId, expiresAt: seconds + ACCESS_SECONDS },
      { hash: hash(refresh), kind: "refresh", clientId, expiresAt: seconds + REFRESH_SECONDS },
    )
    store.write(stored)
    return json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: refresh })
  }

  const clientOf = (stored: Stored, request: Request, form: URLSearchParams): Client | undefined => {
    let id = form.get("client_id") ?? ""
    let given = form.get("client_secret") ?? undefined
    const basic = request.headers.get("authorization")
    if (basic?.startsWith("Basic ")) {
      const [user = "", password = ""] = Buffer.from(basic.slice(6), "base64").toString().split(":")
      id = decodeURIComponent(user)
      given = decodeURIComponent(password)
    }
    const client = stored.clients.find((one) => one.id === id)
    if (!client) return undefined
    if (client.authMethod === "none") return client
    return given !== undefined && client.secretHash && same(hash(given), client.secretHash) ? client : undefined
  }

  const register = async (request: Request) => {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((one) => typeof one === "string") : []
    if (uris.length === 0 || !uris.every(redirectAllowed))
      return oauthError("invalid_redirect_uri", "redirect_uris must be https URLs")
    const requested = body?.token_endpoint_auth_method
    const authMethod: AuthMethod =
      requested === "client_secret_post" || requested === "client_secret_basic" ? requested : "none"
    const clientSecret = authMethod === "none" ? undefined : secret()
    const name = typeof body?.client_name === "string" ? body.client_name.slice(0, 100) : undefined
    const client: Client = {
      id: secret(),
      redirectUris: uris,
      authMethod,
      issuedAt: Math.floor(now() / 1000),
      ...(name ? { name } : {}),
      ...(clientSecret ? { secretHash: hash(clientSecret) } : {}),
    }
    const stored = store.read()
    // Registration is open, so only clients that never got a token make room: a stranger's ten
    // registrations push out each other, never the owner's app.
    const seconds = Math.floor(now() / 1000)
    const holding = new Set(stored.tokens.filter((one) => one.expiresAt > seconds).map((one) => one.clientId))
    stored.clients.push(client)
    while (stored.clients.length > MAX_CLIENTS) {
      const idle = stored.clients.findIndex((one) => !holding.has(one.id))
      if (idle === -1) return oauthError("invalid_client_metadata", "too many logged-in apps — run mcp revoke first")
      stored.clients.splice(idle, 1)
    }
    store.write(stored)
    return json(
      {
        client_id: client.id,
        client_id_issued_at: client.issuedAt,
        redirect_uris: uris,
        token_endpoint_auth_method: authMethod,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...(name ? { client_name: name } : {}),
        ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      },
      201,
    )
  }

  const page = (params: URLSearchParams, client: Client, message?: string) => {
    const hidden = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state"]
      .map((name) => `<input type="hidden" name="${name}" value="${escapeHtml(params.get(name) ?? "")}">`)
      .join("")
    const who = escapeHtml(client.name ?? "an application")
    const target = new URL(params.get("redirect_uri") ?? "")
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(appName)} login</title><style>body{font:16px system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#1d2430}input[type=text]{font:20px ui-monospace,monospace;letter-spacing:.1em;width:100%;padding:.5rem;margin:.5rem 0 1rem;box-sizing:border-box}button{font:inherit;padding:.5rem 1rem}.error{color:#b42318}</style></head><body><h1>${escapeHtml(appName)}</h1><p>An app that calls itself <strong>${who}</strong> asks to reach your messages through <code>${escapeHtml(appName)} mcp --http</code>.</p><p>After you allow it, the login goes to <strong>${escapeHtml(target.host)}</strong>. Allow only if that is the app you are connecting, such as chatgpt.com or claude.ai.</p><p>Type the code shown in WireCat Desktop, or in the terminal where the server runs. If you did not start this login, close this page.</p>${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}<form method="post" action="${escapeHtml(`${base}/authorize`)}">${hidden}<label>Login code<input type="text" name="login_code" autocomplete="off" autofocus required></label><button type="submit">Allow</button></form></body></html>`
    return new Response(html, {
      status: message ? 400 : 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${target.origin}; frame-ancestors 'none'`,
        // no-referrer makes the browser post this form with `Origin: null`, which the Origin check refuses.
        "referrer-policy": "same-origin",
      },
    })
  }

  const authorize = async (request: Request) => {
    const params =
      request.method === "POST" ? new URLSearchParams(await request.text()) : new URL(request.url).searchParams
    const stored = store.read()
    const client = stored.clients.find((one) => one.id === params.get("client_id"))
    const redirectUri = params.get("redirect_uri") ?? ""
    // Never redirect to an address the client did not register: that would hand a code to anyone.
    if (!client?.redirectUris.includes(redirectUri))
      return new Response("Unknown client or redirect address.", { status: 400 })
    if (
      params.get("response_type") !== "code" ||
      params.get("code_challenge_method") !== "S256" ||
      !params.get("code_challenge")
    )
      return new Response("This server needs response_type=code and PKCE with S256.", { status: 400 })
    if (request.method !== "POST") return page(params, client)
    const throttled = () =>
      new Response("Too many wrong codes. Wait, then try the new code.", {
        status: 429,
        headers: { "retry-after": String(Math.ceil((retryAt - now()) / 1000)) },
      })
    if (wrong >= WRONG_TRIES) {
      if (now() < retryAt) return throttled()
      wrong = 0
      freshCode()
    }

    const typed = (params.get("login_code") ?? "").trim().toUpperCase()
    if (login.expires < now()) {
      freshCode()
      return page(params, client, "The code expired. A new one is shown in WireCat Desktop and in the terminal.")
    }
    if (!same(typed, login.value)) {
      wrong += 1
      if (wrong >= WRONG_TRIES) {
        retryAt = now() + WRONG_CODE_WAIT_MS
        return throttled()
      }
      return page(params, client, `Wrong code. ${WRONG_TRIES - wrong} tries left.`)
    }
    wrong = 0
    freshCode()
    const code = secret()
    codes.set(hash(code), {
      clientId: client.id,
      redirectUri,
      challenge: params.get("code_challenge") ?? "",
      expires: now() + AUTH_CODE_MS,
    })
    const target = new URL(redirectUri)
    target.searchParams.set("code", code)
    const state = params.get("state")
    if (state) target.searchParams.set("state", state)
    target.searchParams.set("iss", issuer.href)
    return new Response(null, { status: 302, headers: { location: target.href, "cache-control": "no-store" } })
  }

  const token = async (request: Request) => {
    const form = new URLSearchParams(await request.text())
    const stored = store.read()
    const client = clientOf(stored, request, form)
    if (!client) return oauthError("invalid_client", "unknown client or wrong secret", 401)
    const requestedResource = form.get("resource")
    if (requestedResource && requestedResource !== resource.href)
      return oauthError("invalid_target", "this server issues tokens only for its own MCP endpoint")

    if (form.get("grant_type") === "authorization_code") {
      const key = hash(form.get("code") ?? "")
      const entry = codes.get(key)
      codes.delete(key)
      const verifier = form.get("code_verifier") ?? ""
      const challenge = createHash("sha256").update(verifier).digest("base64url")
      if (
        !entry ||
        entry.expires < now() ||
        entry.clientId !== client.id ||
        entry.redirectUri !== form.get("redirect_uri") ||
        !same(challenge, entry.challenge)
      )
        return oauthError("invalid_grant", "the code is wrong, used or expired")
      return issue(stored, client.id)
    }

    if (form.get("grant_type") === "refresh_token") {
      const key = hash(form.get("refresh_token") ?? "")
      const seconds = Math.floor(now() / 1000)
      const found = stored.tokens.find((one) => one.kind === "refresh" && one.hash === key)
      if (!found || found.clientId !== client.id || found.expiresAt <= seconds)
        return oauthError("invalid_grant", "the refresh token is wrong, used or expired")
      // Rotation: a refresh token works once, so a copied one dies the moment either side uses it.
      stored.tokens = stored.tokens.filter((one) => one !== found)
      return issue(stored, client.id)
    }

    return oauthError("unsupported_grant_type", "use authorization_code or refresh_token")
  }

  const verifier: OAuthTokenVerifier = {
    verifyAccessToken: async (presented) => {
      const seconds = Math.floor(now() / 1000)
      const found = store.read().tokens.find((one) => one.kind === "access" && one.hash === hash(presented))
      if (!found || found.expiresAt <= seconds)
        throw new OAuthError(OAuthErrorCode.InvalidToken, "the token is unknown or expired")
      return {
        token: presented,
        clientId: found.clientId,
        scopes: [],
        expiresAt: found.expiresAt,
        resource,
      } satisfies AuthInfo
    },
  }

  return {
    code: () => login.value,
    close: () => clearTimeout(renewal),
    metadata,
    verifier,
    handle: async (request, path = new URL(request.url).pathname) => {
      if (path === `${base}/register` && request.method === "POST") return register(request)
      if (path === `${base}/authorize` && (request.method === "GET" || request.method === "POST"))
        return authorize(request)
      if (path === `${base}/token` && request.method === "POST") return token(request)
      return undefined
    },
  }
}
