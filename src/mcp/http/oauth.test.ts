import { createHash, randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/server"
import { afterEach, describe, expect, it } from "vitest"
import { freePort, mcpHttpClient } from "../../testing/mcp-http-client.js"
import { httpActivityFile } from "./activity.js"
import { revokeAll } from "./oauth.js"
import { serveOverHttp } from "./serve.js"
import { signedInClients } from "./state.js"

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

const REDIRECT = "https://app.example/callback"

const start = async ({ now, publicUrl }: { now?: () => number; publicUrl?: URL } = {}) => {
  const port = await freePort()
  const base = new URL(`http://127.0.0.1:${port}`)
  const tokenFile = join(mkdtempSync(join(tmpdir(), "mcp-http-")), "state", "mcp-http.json")
  const codes: string[] = []
  const listening = await serveOverHttp(() => new McpServer({ name: "test", version: "1" }), {
    publicUrl: publicUrl ?? base,
    port,
    tokenFile,
    appName: "chat",
    onCode: (code) => codes.push(code),
    ...(now ? { now } : {}),
  })
  closers.push(() => listening.close())
  const at = (path: string) => new URL(path, base)
  const register = async (body: object = {}) => {
    const response = await fetch(at("/register"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "App", ...body }),
    })
    return { status: response.status, body: (await response.json()) as Record<string, string> }
  }
  const pkce = () => {
    const verifier = randomBytes(32).toString("base64url")
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }
  }
  const consent = (clientId: string, challenge: string, loginCode: string, extra: Record<string, string> = {}) =>
    fetch(at("/authorize"), {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "s1",
        login_code: loginCode,
        ...extra,
      }),
    })
  const token = (form: Record<string, string>) =>
    fetch(at("/token"), { method: "POST", body: new URLSearchParams(form) }).then(async (response) => ({
      status: response.status,
      body: (await response.json()) as Record<string, string>,
    }))
  const login = async () => {
    const { body: client } = await register()
    const { verifier, challenge } = pkce()
    const answer = await consent(client.client_id ?? "", challenge, codes.at(-1) ?? "")
    const code = new URL(answer.headers.get("location") ?? "").searchParams.get("code") ?? ""
    const issued = await token({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: client.client_id ?? "",
      code_verifier: verifier,
    })
    return { clientId: client.client_id ?? "", tokens: issued.body }
  }
  const mcp = (accessToken?: string) =>
    fetch(at("/mcp"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
    })
  return { base, at, codes, tokenFile, register, pkce, consent, token, login, mcp }
}

describe("mcp --http and its owner login", () => {
  it("records which tool a logged-in app called and when, never the arguments", async () => {
    const { at, login, tokenFile } = await start()
    const { tokens } = await login()
    await fetch(at("/mcp"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "tg_read", arguments: { chat: "Secret chat" } },
      }),
    })

    const [client] = signedInClients(tokenFile)

    expect(client).toMatchObject({ claimedName: "App", lastTool: "tg_read", toolCallsToday: 1 })
    expect(Date.parse(client?.lastToolAt ?? "")).toBeGreaterThan(Date.now() - 60_000)
    expect(readFileSync(httpActivityFile(tokenFile), "utf8")).not.toMatch(/Secret chat|chat/)
  })

  it("answers MCP without a token with 401 and where to log in", async () => {
    const { mcp } = await start()
    const response = await mcp()
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain("oauth-protected-resource")
  })

  it("serves MCP to a token from the login, and refuses a forged one", async () => {
    const { mcp, login } = await start()
    const { tokens } = await login()
    expect((await mcp(tokens.access_token)).status).toBe(200)
    expect((await mcp("forged")).status).toBe(401)
  })

  it("refuses a Host that is neither the tunnel's nor this machine's", async () => {
    const { at, login } = await start()
    const { tokens } = await login()
    // fetch does not let a caller set Host, so this one goes through node:http.
    const status = await new Promise<number>((resolve, reject) => {
      const sent = request(
        at("/mcp"),
        { method: "POST", headers: { host: "evil.example", authorization: `Bearer ${tokens.access_token}` } },
        (response) => resolve(response.statusCode ?? 0),
      )
      sent.once("error", reject)
      sent.end("{}")
    })
    expect(status).toBe(403)
  })

  it("keeps only hashes of tokens, in a file only the owner can read", async () => {
    const { tokenFile, login } = await start()
    const { tokens } = await login()
    const file = readFileSync(tokenFile, "utf8")
    expect(file).not.toContain(tokens.access_token)
    expect(file).not.toContain(tokens.refresh_token)
    if (process.platform !== "win32") expect(statSync(tokenFile).mode & 0o777).toBe(0o600)
  })

  it("throttles wrong codes and recovers with a fresh terminal code without a restart", async () => {
    let now = Date.now()
    const { register, pkce, consent, codes } = await start({ now: () => now })
    const { body: client } = await register()
    const { challenge } = pkce()
    const previous = codes.at(-1) ?? ""
    for (let i = 0; i < 5; i++) await consent(client.client_id ?? "", challenge, "WRONG-CODE")
    const locked = await consent(client.client_id ?? "", challenge, previous)
    expect(locked.status).toBe(429)
    expect(locked.headers.get("retry-after")).toBe("30")
    now += 30_000
    expect((await consent(client.client_id ?? "", challenge, previous)).status).toBe(400)
    expect(codes.at(-1)).not.toBe(previous)
    expect((await consent(client.client_id ?? "", challenge, codes.at(-1) ?? "")).status).toBe(302)
  })

  it("rejects multibyte codes without throwing and resets the failed-attempt budget after login", async () => {
    const { register, pkce, consent, codes } = await start()
    const { body: client } = await register()
    const { challenge } = pkce()
    expect((await consent(client.client_id ?? "", challenge, "éBCD-EFGH")).status).toBe(400)
    for (let i = 0; i < 3; i++) await consent(client.client_id ?? "", challenge, "WRONG-CODE")
    expect((await consent(client.client_id ?? "", challenge, codes.at(-1) ?? "")).status).toBe(302)
    expect((await consent(client.client_id ?? "", challenge, "WRONG-CODE")).status).toBe(400)
  })

  it("issues a new terminal code after each login, so a code works once", async () => {
    const { register, pkce, consent, codes } = await start()
    const { body: client } = await register()
    const used = codes.at(-1) ?? ""
    expect((await consent(client.client_id ?? "", pkce().challenge, used)).status).toBe(302)
    expect(codes.at(-1)).not.toBe(used)
    const again = await consent(client.client_id ?? "", pkce().challenge, used)
    expect(again.status).toBe(400)
    expect(await again.text()).toContain("Each code works for one login")
  })

  it("never redirects to an address the client did not register", async () => {
    const { register, pkce, consent, codes } = await start()
    const { body: client } = await register()
    const answer = await consent(client.client_id ?? "", pkce().challenge, codes.at(-1) ?? "", {
      redirect_uri: "https://attacker.example/cb",
    })
    expect(answer.status).toBe(400)
    expect(answer.headers.get("location")).toBeNull()
  })

  it("refuses plain PKCE, a wrong verifier, and a code used twice", async () => {
    const { register, pkce, consent, token, codes } = await start()
    const { body: client } = await register()
    const id = client.client_id ?? ""
    expect((await consent(id, "x", codes.at(-1) ?? "", { code_challenge_method: "plain" })).status).toBe(400)

    const { verifier, challenge } = pkce()
    const answer = await consent(id, challenge, codes.at(-1) ?? "")
    const code = new URL(answer.headers.get("location") ?? "").searchParams.get("code") ?? ""
    const exchange = (code_verifier: string) =>
      token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: id, code_verifier })
    expect((await exchange("wrong")).body.error).toBe("invalid_grant")
    expect((await exchange(verifier)).body.error).toBe("invalid_grant")
  })

  it("accepts only https redirect addresses at registration", async () => {
    const { register } = await start()
    expect((await register({ redirect_uris: ["http://app.example/cb"] })).status).toBe(400)
  })

  it("rotates refresh tokens: one works once, then never again", async () => {
    const { login, token } = await start()
    const { clientId, tokens } = await login()
    const refresh = (refresh_token: string) =>
      token({ grant_type: "refresh_token", refresh_token, client_id: clientId })
    const next = await refresh(tokens.refresh_token ?? "")
    expect(next.status).toBe(200)
    expect((await refresh(tokens.refresh_token ?? "")).body.error).toBe("invalid_grant")
    expect((await refresh(next.body.refresh_token ?? "")).status).toBe(200)
  })

  it("expires access tokens after an hour", async () => {
    let now = Date.now()
    const { login, mcp } = await start({ now: () => now })
    const { tokens } = await login()
    now += 61 * 60 * 1000
    expect((await mcp(tokens.access_token)).status).toBe(401)
  })

  it("drops every token on revoke", async () => {
    const { login, mcp, tokenFile } = await start()
    const { tokens } = await login()
    revokeAll(tokenFile)
    expect((await mcp(tokens.access_token)).status).toBe(401)
  })

  it("works as deployed: the apps know only the tunnel's https address, the server listens on 127.0.0.1", async () => {
    const publicUrl = new URL("https://name.test")
    const { base, codes } = await start({ publicUrl })
    const { client } = await mcpHttpClient(base, () => codes.at(-1) ?? "", { publicUrl })
    expect(await client.listTools()).toMatchObject({ tools: [] })
    await client.close()
  })

  it("logs a real client in under a path of a shared address, one path per tool", async () => {
    const publicUrl = new URL("https://name.test/tg")
    const { base, codes } = await start({ publicUrl })
    const { client } = await mcpHttpClient(base, () => codes.at(-1) ?? "", { publicUrl })
    expect(await client.listTools()).toMatchObject({ tools: [] })
    await client.close()
  })

  it("under a path, finds its metadata where RFC 8414 and RFC 9728 put it, and takes a tunnel that drops the path", async () => {
    const { at, register, pkce } = await start({ publicUrl: new URL("https://name.test/tg/") })
    const refused = await fetch(at("/mcp"), { method: "POST", body: "{}" })
    expect(refused.status).toBe(401)
    expect(refused.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://name.test/.well-known/oauth-protected-resource/tg/mcp"',
    )
    const resource = await (await fetch(at("/.well-known/oauth-protected-resource/tg/mcp"))).json()
    expect(resource).toMatchObject({
      resource: "https://name.test/tg/mcp",
      authorization_servers: ["https://name.test/tg"],
    })
    const issuer = await (await fetch(at("/.well-known/oauth-authorization-server/tg"))).json()
    expect(issuer).toMatchObject({
      issuer: "https://name.test/tg",
      authorization_endpoint: "https://name.test/tg/authorize",
      token_endpoint: "https://name.test/tg/token",
      registration_endpoint: "https://name.test/tg/register",
    })
    const { body: client } = await register()
    const query = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id ?? "",
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    })
    expect(await (await fetch(at(`/tg/authorize?${query}`))).text()).toContain('action="/tg/authorize"')
  })

  it("refuses an oversized body before reading it, on the login routes and on MCP", async () => {
    const { at } = await start()
    const big = "x".repeat(70 * 1024)
    expect((await fetch(at("/register"), { method: "POST", body: big })).status).toBe(413)
    expect((await fetch(at("/mcp"), { method: "POST", body: "x".repeat(5 * 1024 * 1024) })).status).toBe(413)
  })

  it("keeps the owner's logged-in app when strangers register many more", async () => {
    const { login, register, token } = await start()
    const { clientId, tokens } = await login()
    for (let i = 0; i < 15; i++) await register()
    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token ?? "",
      client_id: clientId,
    })
    expect(refreshed.status).toBe(200)
  })

  it("names on the consent page where the login goes, and lets the form reach only there", async () => {
    const { at, register, pkce } = await start()
    const { body: client } = await register({ client_name: "ChatGPT" })
    const query = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id ?? "",
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    })
    const page = await fetch(at(`/authorize?${query}`))
    const html = await page.text()
    expect(html).toContain("calls itself <strong>ChatGPT</strong>")
    expect(html).toContain("the login goes to <strong>app.example</strong>")
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self' https://app.example;")
    expect(page.headers.get("x-frame-options")).toBe("DENY")
  })

  it("lets the consent form post from the tunnel's own origin, as a browser sends it", async () => {
    const { at, register, pkce, codes, base } = await start()
    const { body: client } = await register()
    const query = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id ?? "",
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    })
    const page = await fetch(at(`/authorize?${query}`))
    expect(page.headers.get("referrer-policy")).toBe("same-origin")
    const posted = await fetch(at("/authorize"), {
      method: "POST",
      redirect: "manual",
      headers: { origin: base.origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...Object.fromEntries(query), login_code: codes.at(-1) ?? "" }),
    })
    expect(posted.status).toBe(302)
  })

  it("refuses a request that carries a foreign Origin", async () => {
    const { at } = await start()
    const response = await fetch(at("/register"), {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    })
    expect(response.status).toBe(403)
  })
})
