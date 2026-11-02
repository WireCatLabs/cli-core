import { createHash, randomBytes } from "node:crypto"
import { createServer, type RequestListener } from "node:http"
import { CliError, isCliError } from "@wirecat/cli-base"
import type { OAuthProvider } from "./provider.js"

export interface AuthorizeOptions {
  provider: OAuthProvider
  scopes: readonly string[]
  openBrowser: (url: string) => Promise<void>
  showUrl?: (url: string) => void
  /** The redirected URL, or its query, pasted when the browser cannot reach this machine's loopback. */
  readPaste?: (signal: AbortSignal) => Promise<string>
  timeoutMs?: number
  signal?: AbortSignal
}

export interface Authorization {
  code: string
  redirectUri: string
  codeVerifier: string
}

const DEFAULT_TIMEOUT_MS = 300_000

const pkce = () => {
  const codeVerifier = randomBytes(48).toString("base64url")
  return { codeVerifier, codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url") }
}

const queryOf = (text: string) => {
  const trimmed = text.trim()
  const start = trimmed.indexOf("?")
  return new URLSearchParams(start >= 0 ? trimmed.slice(start + 1).split("#")[0] : trimmed)
}

/**
 * Authorization code with PKCE S256 for an installed app: a loopback listener on 127.0.0.1, a `state` check, a
 * timeout, cancel and a paste fallback. Answers the code without exchanging it.
 */
export const authorize = async (options: AuthorizeOptions): Promise<Authorization> => {
  const { provider } = options
  const cancelled = () =>
    isCliError(options.signal?.reason)
      ? options.signal.reason
      : new CliError("cancelled", `${provider.name} sign-in was cancelled`)
  if (options.signal?.aborted) throw cancelled()
  const { codeVerifier, codeChallenge } = pkce()
  const paste = new AbortController()
  let state = ""
  let settled = false
  let accept: (code: string) => void = () => {}
  let fail: (error: Error) => void = () => {}
  const code = new Promise<string>((resolve, reject) => {
    accept = (value) => {
      settled = true
      resolve(value)
    }
    fail = (error) => {
      settled = true
      reject(error)
    }
  })
  void code.catch(() => {})
  const settle = (query: URLSearchParams) => {
    const value = query.get("code")
    if (value) accept(value)
    else
      fail(new CliError("authentication_error", `${provider.name} sign-in was declined`, { reason: "oauth.declined" }))
  }
  const handler: RequestListener = (request, response) => {
    let url: URL
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1")
    } catch {
      response.writeHead(400).end()
      return
    }
    if (request.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404).end()
      return
    }
    if (settled || !state || url.searchParams.get("state") !== state) {
      response.writeHead(400).end("This sign-in link does not belong to the waiting sign-in")
      return
    }
    if (!url.searchParams.get("code") && !url.searchParams.get("error")) {
      response.writeHead(400).end("Missing sign-in result")
      return
    }
    response.end("Sign-in received; you can close this tab")
    settle(url.searchParams)
  }
  const server = createServer(handler)
  const localhost = provider.redirect.kind === "loopback" && provider.redirect.host === "localhost"
  // `localhost` may resolve to ::1 in the browser; the IPv6 listener is best effort, as some hosts have no IPv6.
  const server6 = localhost ? createServer(handler) : undefined
  const onAbort = () => fail(cancelled())
  options.signal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(
    () => fail(new CliError("timeout", `${provider.name} sign-in timed out`, { reason: "oauth.timeout" })),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    if (!address || typeof address === "string")
      throw new CliError("configuration_error", "could not start the local sign-in listener")
    if (server6) {
      server6.on("error", () => {})
      await new Promise<void>((resolve) => {
        server6.once("error", () => resolve())
        server6.listen(address.port, "::1", () => resolve())
      })
    }
    const random = randomBytes(32).toString("base64url")
    const relay = provider.redirect.kind === "relay"
    state = relay ? `${address.port}.${random}` : random
    const redirectUri =
      provider.redirect.kind === "relay"
        ? provider.redirect.url
        : `http://${localhost ? "localhost" : "127.0.0.1"}:${address.port}/callback`
    const url = new URL(provider.authorizeUrl)
    for (const [key, value] of Object.entries({
      ...provider.authorizeParams,
      response_type: "code",
      client_id: provider.client.clientId,
      redirect_uri: redirectUri,
      ...(options.scopes.length ? { scope: options.scopes.join(" ") } : {}),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }))
      url.searchParams.set(key, value)
    options.showUrl?.(url.toString())
    options
      .readPaste?.(paste.signal)
      .then((text) => {
        if (settled) return
        const query = queryOf(text)
        if (query.get("state") !== state || (!query.get("code") && !query.get("error")))
          fail(
            new CliError("authentication_error", "the pasted sign-in result does not match this sign-in", {
              reason: "oauth.mismatch",
            }),
          )
        else settle(query)
      })
      .catch(() => {})
    void Promise.resolve()
      .then(() => options.openBrowser(url.toString()))
      .catch(() => {
        if (!options.readPaste && !options.showUrl)
          fail(new CliError("configuration_error", "could not open the browser, and no sign-in link can be shown"))
      })
    return { code: await code, redirectUri, codeVerifier }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", onAbort)
    paste.abort()
    for (const each of server6 ? [server, server6] : [server]) {
      each.closeAllConnections()
      if (each.listening) await new Promise<void>((resolve) => each.close(() => resolve()))
    }
  }
}
