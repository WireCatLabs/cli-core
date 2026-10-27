import { createServer } from "node:net"
import {
  Client,
  type ElicitResult,
  type OAuthClientProvider,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client"

const REDIRECT = "http://localhost/callback"

/** A port nothing listens on, so the public URL and the listener can agree before the server starts. */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0))
    })
  })

/**
 * An MCP client that logs in the way a browser app does: registers, opens the consent page, types
 * the owner's terminal code there, and swaps the code it gets back for tokens.
 */
export const mcpHttpClient = async (
  base: URL,
  loginCode: () => string,
  {
    era = "legacy",
    form,
    publicUrl,
  }: {
    era?: "legacy" | "modern"
    form?: (message: string) => ElicitResult
    /**
     * As in production: the client knows only the tunnel's address, which leads to `base` with every path kept —
     * a path in it is the tool's share of one address (`--set-path /tg http://127.0.0.1:<port>/tg`).
     */
    publicUrl?: URL
  } = {},
) => {
  const at = publicUrl ?? base
  const endpoint = new URL(`${at.pathname.replace(/\/+$/, "")}/mcp`, at.origin)
  // Every address the client meets — the tunnel's, the issuer's — leads to the one local port.
  const tunnel: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const local = new URL(url.pathname + url.search, base)
    return input instanceof Request ? fetch(new Request(local, input), init) : fetch(local, init)
  }
  const saved: { info?: object; tokens?: object; verifier?: string; consentAt?: URL } = {}
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return REDIRECT
    },
    get clientMetadata() {
      return {
        client_name: "Test app",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }
    },
    clientInformation: () => saved.info as never,
    saveClientInformation: (info) => {
      saved.info = info
    },
    tokens: () => saved.tokens as never,
    saveTokens: (tokens) => {
      saved.tokens = tokens
    },
    redirectToAuthorization: (url) => {
      saved.consentAt = url
    },
    saveCodeVerifier: (verifier) => {
      saved.verifier = verifier
    },
    codeVerifier: () => saved.verifier ?? "",
  }
  const forms: string[] = []
  const fresh = () => {
    const client = new Client(
      { name: "test", version: "1.0.0" },
      {
        ...(form ? { capabilities: { elicitation: {} } } : {}),
        ...(era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {}),
      },
    )
    if (form)
      client.setRequestHandler("elicitation/create", async (request) => {
        forms.push(request.params.message)
        return form(request.params.message)
      })
    return client
  }

  const transportOptions = { authProvider: provider, ...(publicUrl ? { fetch: tunnel } : {}) }
  const first = new StreamableHTTPClientTransport(endpoint, transportOptions)
  try {
    await fresh().connect(first)
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error
  }
  if (!saved.consentAt) throw new Error("the server did not ask the client to log in")
  const typed = new URLSearchParams(saved.consentAt.searchParams)
  typed.set("login_code", loginCode())
  const answer = await fetch(new URL(saved.consentAt.pathname, base), {
    method: "POST",
    body: typed,
    redirect: "manual",
  })
  const location = answer.headers.get("location")
  if (answer.status !== 302 || !location) throw new Error(`consent refused: ${answer.status}`)
  await first.finishAuth(new URL(location).searchParams.get("code") ?? "")

  const client = fresh()
  await client.connect(new StreamableHTTPClientTransport(endpoint, transportOptions))
  return { client, forms, tokens: () => saved.tokens as { access_token: string; refresh_token?: string } | undefined }
}
