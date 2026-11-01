import { CLIENT_INFO_META_KEY } from "@modelcontextprotocol/server"
import {
  agentOf,
  clientHash,
  currentCaller,
  type RunAgent,
  type RunCaller,
  type RunClient,
} from "../runs/run-context.js"

export { currentCaller, withCaller } from "../runs/run-context.js"

/**
 * The name the audit log keeps for the agent behind one call: the client as it named itself, else the coding agent
 * whose environment started a stdio server, else `fallback`. A client's name is its own claim, a label and never a
 * permission (MCP's `clientInfo` is self-reported).
 */
export const callingAgent = (fallback: string, caller: RunCaller | undefined = currentCaller()): string => {
  const client = caller?.agent?.client?.name
  if (client && client !== "unknown") return client
  const kind = caller?.agent?.kind
  return kind && kind !== "mcp-client" ? kind : fallback
}

/** The `_meta` key the every-profile server names the real caller under, for the profile server it passes a call to. */
export const CALLER_META_KEY = "wirecat.dev/caller"
/** The name the every-profile server gives itself in `initialize`; only a connection from it may name a caller. */
export const PROXY_CLIENT_NAME = "all-profiles"

/** What a tool call's handler is given, reduced to what identifies the caller. */
export interface CallContext {
  sessionId?: string | undefined
  mcpReq?: { id?: string | number; _meta?: Record<string, unknown> | undefined } | undefined
  http?: { authInfo?: { clientId: string; extra?: Record<string, unknown> | undefined } | undefined } | undefined
}

export interface CallerSource {
  /** This server's environment: the coding agent that started a stdio server. Never read for an HTTP call. */
  env: NodeJS.ProcessEnv
  /** The client's `initialize`, when this connection had one. */
  client?: () => { name: string; version?: string } | undefined
  /** One id per stdio connection, made when the server starts. */
  connectionId?: string
}

const NAME = /^[\w .@()/+-]{1,64}$/
const plain = (value: unknown): string | undefined =>
  typeof value === "string" && NAME.test(value.trim()) ? value.trim() : undefined

const clientFrom = (value: unknown): RunClient | undefined => {
  if (!value || typeof value !== "object") return undefined
  const { name, version } = value as Record<string, unknown>
  const named = plain(name)
  if (!named) return undefined
  const versioned = plain(version)
  return { name: named, ...(versioned ? { version: versioned } : {}) }
}

/**
 * Who made one MCP call. Over HTTP the server's own environment is somebody else's — whoever started `mcp --http` —
 * so the caller is the OAuth client (its registered name and a hash of its id) and the HTTP session, if any. Over
 * stdio the agent that started the server is the caller, and `initialize` names its client. A call the every-profile
 * server passed on carries the caller it worked out, trusted only on a connection that server opened.
 */
export const callerOf = (ctx: CallContext | undefined, tool: string, source: CallerSource): RunCaller => {
  const meta = ctx?.mcpReq?._meta
  const requestId = ctx?.mcpReq?.id
  const initialized = source.client?.()
  const proxied = initialized?.name === PROXY_CLIENT_NAME ? passedOn(meta?.[CALLER_META_KEY], tool) : undefined
  if (proxied) return proxied
  const client = clientFrom(meta?.[CLIENT_INFO_META_KEY]) ?? clientFrom(initialized)
  const mcp = (connection: string | undefined) => ({
    tool,
    ...(requestId === undefined ? {} : { request_id: String(requestId) }),
    ...(connection ? { connection_id: connection } : {}),
  })
  const auth = ctx?.http?.authInfo
  if (auth) {
    const registered = plain(auth.extra?.clientName)
    return {
      via: "mcp-http",
      agent: {
        kind: "mcp-client",
        session_id: ctx?.sessionId ?? null,
        client: {
          name: registered ?? client?.name ?? "unknown",
          ...(client?.version ? { version: client.version } : {}),
          id: clientHash(auth.clientId),
        },
      },
      mcp: mcp(ctx?.sessionId),
    }
  }
  const agent: RunAgent = agentOf(source.env) ?? { kind: "mcp-client", session_id: null }
  return { via: "mcp-stdio", agent: { ...agent, ...(client ? { client } : {}) }, mcp: mcp(source.connectionId) }
}

/** The caller the every-profile server named, field by field: nothing else it sent reaches a run. */
const passedOn = (value: unknown, tool: string): RunCaller | undefined => {
  if (!value || typeof value !== "object") return undefined
  const { via, agent, mcp } = value as Record<string, unknown>
  if (via !== "mcp-stdio" && via !== "mcp-http") return undefined
  const a = agent && typeof agent === "object" ? (agent as Record<string, unknown>) : undefined
  const kind = plain(a?.kind)
  const session =
    typeof a?.session_id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(a.session_id) ? a.session_id : null
  const client = clientFrom(a?.client)
  const id = a?.client && typeof a.client === "object" ? (a.client as Record<string, unknown>).id : undefined
  const m = mcp && typeof mcp === "object" ? (mcp as Record<string, unknown>) : {}
  const request = plain(m.request_id)
  const connection =
    typeof m.connection_id === "string" && /^[\w-]{1,128}$/.test(m.connection_id) ? m.connection_id : undefined
  return {
    via,
    ...(kind
      ? {
          agent: {
            kind,
            session_id: session,
            ...(a?.from_chat === true ? { from_chat: true as const } : {}),
            ...(client
              ? { client: { ...client, ...(typeof id === "string" && /^[0-9a-f]{8}$/.test(id) ? { id } : {}) } }
              : {}),
          },
        }
      : {}),
    mcp: {
      tool,
      ...(request ? { request_id: request } : {}),
      ...(connection ? { connection_id: connection } : {}),
      proxied: true,
    },
  }
}
