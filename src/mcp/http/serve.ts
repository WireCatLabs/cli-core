import { randomUUID } from "node:crypto"
import {
  type AuthInfo,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  isLegacyRequest,
  type McpServer,
  oauthMetadataResponse,
  requireBearerAuth,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server"
import { CliError } from "@wirecat/cli-base"
import { type Listening, listen } from "../../http/listen.js"
import { ownerLogin } from "./oauth.js"
import { httpLock } from "./state.js"

export const MCP_PATH = "/mcp"
const AS_METADATA = "/.well-known/oauth-authorization-server"
const LOCAL = ["localhost", "127.0.0.1"]
const MAX_SESSIONS = 20
const MAX_LOGIN_BODY = 64 * 1024
const SESSION_IDLE_MS = 60 * 60 * 1000

interface LegacySession {
  transport: WebStandardStreamableHTTPServerTransport
  close(): Promise<void>
  clientId: string
  seen: number
}

const sessionMissing = () =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }), {
    status: 404,
    headers: { "content-type": "application/json" },
  })

/**
 * 2025-era clients — the browser apps today — say once, in `initialize`, that they can show a form.
 * A stateless server forgets that by the next request and refuses every confirmation, so these
 * clients get a session: one server per session, bound to the OAuth client that opened it.
 */
const legacySessions = (build: () => McpServer, now: () => number) => {
  const sessions = new Map<string, LegacySession>()
  const drop = async (id: string) => {
    const one = sessions.get(id)
    sessions.delete(id)
    await one?.close()
  }
  const handle = async (request: Request, auth: AuthInfo): Promise<Response> => {
    for (const [id, one] of sessions) if (now() - one.seen > SESSION_IDLE_MS) await drop(id)
    const id = request.headers.get("mcp-session-id")
    if (id) {
      const known = sessions.get(id)
      if (!known || known.clientId !== auth.clientId) return sessionMissing()
      known.seen = now()
      return known.transport.handleRequest(request, { authInfo: auth })
    }
    const server = build()
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessionclosed: (closed) => void sessions.delete(closed),
    })
    await server.connect(transport)
    const response = await transport.handleRequest(request, { authInfo: auth })
    if (!transport.sessionId) {
      await server.close()
      return response
    }
    sessions.set(transport.sessionId, { transport, close: () => server.close(), clientId: auth.clientId, seen: now() })
    while (sessions.size > MAX_SESSIONS) await drop(sessions.keys().next().value as string)
    return response
  }
  return {
    handle,
    close: async () => {
      for (const id of [...sessions.keys()]) await drop(id)
    },
  }
}

/**
 * The SDK answers the issuer's metadata only at the bare `/.well-known/oauth-authorization-server`; the path-inserted
 * form a path issuer is found at is the same document. Only GET and OPTIONS reach it, so no body is carried over.
 */
const metadataRequest = (request: Request, path: string, base: string): Request => {
  const url = new URL(request.url)
  const inserted = base && path === `${AS_METADATA}${base}`
  if (!inserted && url.pathname === path) return request
  url.pathname = inserted ? AS_METADATA : path
  return new Request(url, { method: request.method, headers: request.headers })
}

export interface HttpOptions {
  /**
   * The tunnel's address, as the browser apps reach it — `https://name.ts.net`, or under a path when tools share
   * one address, `https://name.ts.net/tg`. Under a path the issuer carries it too, so RFC 8414 puts the issuer's
   * metadata at the root, `/.well-known/oauth-authorization-server/tg`, and the resource's at
   * `/.well-known/oauth-protected-resource/tg/mcp` (RFC 9728): the tunnel routes both here, as well as `/tg`.
   */
  publicUrl: URL
  port: number
  /** Where the hashes of issued tokens and registered clients are kept. */
  tokenFile: string
  appName: string
  onCode: (code: string, expires: Date) => void
  onError?: (error: Error) => void
  now?: () => number
  /**
   * `httpLockFile(tokenFile)`: one server per token file, and what `mcp server status` reads — the
   * port, the address and the current login code. Without it nothing is written.
   */
  lockFile?: string
  version?: string
}

/**
 * MCP over Streamable HTTP on 127.0.0.1, behind the owner's tunnel (CLI-58). Every MCP request needs
 * a token from the owner login; the Host header must be the tunnel's or this machine's, so a page in
 * the owner's browser cannot reach the port through a rebound DNS name.
 */
export const serveOverHttp = async (build: () => McpServer, options: HttpOptions): Promise<Listening> => {
  const { publicUrl, port, tokenFile, appName, onCode, onError, now, lockFile, version } = options
  const lock = lockFile
    ? httpLock(lockFile, {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        port,
        publicUrl: publicUrl.href,
        ...(version ? { version } : {}),
      })
    : undefined
  if (lock?.held)
    throw new CliError(
      "validation_error",
      `${appName} already serves MCP over HTTP for this profile on port ${lock.held.port} (PID ${lock.held.pid}, since ${lock.held.startedAt})`,
    )
  const base = publicUrl.pathname === "/" ? "" : publicUrl.pathname.replace(/\/+$/, "")
  const issuer = new URL(`${publicUrl.origin}${base}`)
  const resource = new URL(`${base}${MCP_PATH}`, publicUrl.origin)
  const mcpPath = resource.pathname
  // A tunnel that drops the path on the way (`--set-path /tg http://127.0.0.1:<port>`) hands over `/mcp`.
  const publicPath = (path: string) =>
    base && path !== base && !path.startsWith(`${base}/`) && !path.startsWith("/.well-known/") ? `${base}${path}` : path
  const login = ownerLogin({
    issuer,
    resource,
    file: tokenFile,
    appName,
    onCode: (code, expires) => {
      lock?.update({ loginCode: code, loginCodeExpiresAt: expires.toISOString() })
      onCode(code, expires)
    },
    ...(now ? { now } : {}),
  })
  const insecure = issuer.protocol === "http:" && LOCAL.includes(issuer.hostname)
  const mcp = createMcpHandler(build, { legacy: "reject", ...(onError ? { onerror: onError } : {}) })
  const legacy = legacySessions(build, now ?? Date.now)
  const bearer = requireBearerAuth({
    verifier: login.verifier,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
  })
  const allowedHosts = [...new Set([publicUrl.hostname, ...LOCAL])]
  const allowedOrigins = [publicUrl.origin]

  const listening = await listen(
    async (request) => {
      const refused = hostHeaderValidationResponse(request, allowedHosts)
      if (refused) return refused
      const path = publicPath(new URL(request.url).pathname)
      const discovery = oauthMetadataResponse(metadataRequest(request, path, base), {
        oauthMetadata: login.metadata,
        resourceServerUrl: resource,
        resourceName: appName,
        ...(insecure ? { dangerouslyAllowInsecureIssuerUrl: true } : {}),
      })
      if (discovery) return discovery
      if (Number(request.headers.get("content-length") ?? 0) > MAX_LOGIN_BODY && path !== mcpPath)
        return new Response("Request too large", { status: 413 })
      const origin = request.headers.get("origin")
      // The apps call from their servers, with no Origin; a page in some browser tab carries its own.
      if (origin && !allowedOrigins.includes(origin)) return new Response("Origin not allowed", { status: 403 })
      const answered = await login.handle(request, path)
      if (answered) return answered
      if (path !== mcpPath) return new Response("Not found", { status: 404 })
      const auth = await bearer(request)
      if (auth instanceof Response) return auth
      return (await isLegacyRequest(request)) ? legacy.handle(request, auth) : mcp.fetch(request, { authInfo: auth })
    },
    { host: "127.0.0.1", port },
  ).catch((error: unknown) => {
    login.close()
    lock?.release()
    throw error
  })
  lock?.update({ listeningAt: new Date().toISOString() })
  return {
    url: listening.url,
    close: async () => {
      login.close()
      try {
        await listening.close()
        await legacy.close()
        await mcp.close()
      } finally {
        lock?.release()
      }
    },
  }
}
