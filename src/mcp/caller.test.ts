import { CLIENT_INFO_META_KEY } from "@modelcontextprotocol/server"
import { describe, expect, it } from "vitest"
import { clientHash, keepsSuccess, runContextOf } from "../runs/run-context.js"
import { CALLER_META_KEY, callerOf, PROXY_CLIENT_NAME } from "./caller.js"

const claude = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "synthetic-session" }
const stdio = { env: claude, client: () => ({ name: "claude-code", version: "2.1" }), connectionId: "conn-1" }

describe("callerOf", () => {
  it("over stdio keeps the starting agent, the client and the connection", () => {
    expect(callerOf({ mcpReq: { id: 7 } }, "tg_chats_list", stdio)).toEqual({
      via: "mcp-stdio",
      agent: { kind: "claude-code", session_id: "synthetic-session", client: { name: "claude-code", version: "2.1" } },
      mcp: { tool: "tg_chats_list", request_id: "7", connection_id: "conn-1" },
    })
  })

  it("prefers the client a request names over the one initialize named", () => {
    const ctx = { mcpReq: { id: 1, _meta: { [CLIENT_INFO_META_KEY]: { name: "cursor", version: "3" } } } }
    expect(callerOf(ctx, "t", stdio).agent?.client).toEqual({ name: "cursor", version: "3" })
  })

  it("is an MCP client of its own when no agent started the server", () => {
    expect(callerOf(undefined, "t", { env: {} }).agent).toEqual({ kind: "mcp-client", session_id: null })
  })

  it("over HTTP never reads the server's environment and hashes the OAuth client id", () => {
    const ctx = {
      sessionId: "http-session",
      mcpReq: { id: "a" },
      http: { authInfo: { clientId: "raw-client-id", extra: { clientName: "claude.ai" } } },
    }
    const caller = callerOf(ctx, "t", stdio)
    expect(caller).toEqual({
      via: "mcp-http",
      agent: {
        kind: "mcp-client",
        session_id: "http-session",
        client: { name: "claude.ai", version: "2.1", id: clientHash("raw-client-id") },
      },
      mcp: { tool: "t", request_id: "a", connection_id: "http-session" },
    })
    expect(JSON.stringify(caller)).not.toContain("raw-client-id")
    expect(JSON.stringify(caller)).not.toContain("synthetic-session")
  })

  it("trusts a passed-on caller only on a connection the every-profile server opened", () => {
    const named = {
      via: "mcp-http",
      agent: { kind: "mcp-client", session_id: null, client: { name: "ChatGPT", id: "0a1b2c3d" }, extra: "x" },
      mcp: { tool: "ignored", request_id: "9", connection_id: "s-1" },
    }
    const ctx = { mcpReq: { id: 1, _meta: { [CALLER_META_KEY]: named } } }
    const proxied = callerOf(ctx, "tg_chats_list", { env: {}, client: () => ({ name: PROXY_CLIENT_NAME }) })
    expect(proxied).toEqual({
      via: "mcp-http",
      agent: { kind: "mcp-client", session_id: null, client: { name: "ChatGPT", id: "0a1b2c3d" } },
      mcp: { tool: "tg_chats_list", request_id: "9", connection_id: "s-1", proxied: true },
    })
    const stranger = callerOf(ctx, "tg_chats_list", { env: {}, client: () => ({ name: "evil" }) })
    expect(stranger.mcp?.proxied).toBeUndefined()
    expect(stranger.agent?.client?.name).toBe("evil")
  })
})

describe("runContextOf", () => {
  it("records the caller instead of the environment's agent", () => {
    const caller = { via: "mcp-http" as const, agent: { kind: "mcp-client", session_id: null } }
    expect(runContextOf({ bin: "tg", command: "mcp chats list", env: claude, caller })).toMatchObject({
      agent: { kind: "mcp-client", session_id: null },
      via: "mcp-http",
    })
  })

  it("says a command came from the terminal, or from WireCat Desktop", () => {
    expect(runContextOf({ bin: "tg", command: "chats list", env: {} }).via).toBe("cli")
    expect(runContextOf({ bin: "tg", command: "chats list", env: { WIRECAT_CALLER: "desktop" } }).via).toBe("desktop")
  })
})

describe("keepsSuccess", () => {
  const desktop = { WIRECAT_CALLER: "desktop" }
  it("keeps every success unless the config says no, or Desktop or a long-running command asked without --record", () => {
    expect(keepsSuccess({ record: true, fromFlag: false, env: {} })).toBe(true)
    expect(keepsSuccess({ record: false, fromFlag: false, env: {} })).toBe(false)
    expect(keepsSuccess({ record: true, fromFlag: false, env: desktop })).toBe(false)
    expect(keepsSuccess({ record: true, fromFlag: true, env: desktop })).toBe(true)
    expect(keepsSuccess({ record: true, fromFlag: false, env: {}, persistent: true })).toBe(false)
    expect(keepsSuccess({ record: true, fromFlag: true, env: {}, persistent: true })).toBe(true)
  })

  it("keeps an MCP call's success even on a server WireCat Desktop started", () => {
    expect(keepsSuccess({ record: true, fromFlag: false, env: desktop, caller: { via: "mcp-http" } })).toBe(true)
  })
})
