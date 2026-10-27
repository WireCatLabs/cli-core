import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { Readable, Writable } from "node:stream"
import { type CallToolResult, McpServer, type Tool } from "@modelcontextprotocol/server"
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio"
import { CALLER_META_KEY, callerOf, PROXY_CLIENT_NAME } from "./caller.js"
import type { HttpOptions } from "./http/serve.js"
import { answeredWire } from "./stdio-wire.js"

const PROTOCOL = "2025-06-18"
const START_MS = 30_000
export const CHILD_IDLE_MS = 10 * 60 * 1000

/** How to start the one-profile server for a profile: `<node> <script> <profile> mcp`. */
export interface ChildSpec {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export interface AllProfilesOptions {
  /** `tg`: the tools' prefix and the server's name. */
  command: string
  version: string
  /** `Telegram`: what the `profile` field says it picks. */
  name: string
  /** Read again for each new session, so a profile set up while serving over HTTP shows up. */
  profiles: () => readonly string[]
  /** Whether a profile has a session now; unset, every one does. A call for one without is refused with `signIn`. */
  signedIn?: (profile: string) => boolean
  /** How to sign a profile in, for the refusal of a call it cannot serve yet. */
  signIn?: (profile: string) => string
  child: (profile: string) => ChildSpec
  instructions: string
  idleMs?: number
  /** A child's stderr, line by line; never this process's stdout, which carries the protocol. */
  note?: (line: string) => void
  /** This server's environment, which names the agent that started it on stdio; `process.env` when left out. */
  env?: NodeJS.ProcessEnv
}

interface Child {
  request(method: string, params: object): Promise<Record<string, unknown>>
  close(): Promise<void>
}

/** A JSON-RPC client over one child's stdin and stdout, as `probeStdio` in cli-base talks to a server. */
const startChild = (spec: ChildSpec, note: (line: string) => void, onExit: () => void): Promise<Child> => {
  const child: ChildProcessWithoutNullStreams = spawn(spec.command, spec.args, { env: spec.env, stdio: "pipe" })
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (e: Error) => void }>()
  let next = 1
  let buffer = ""
  let gone: Error | undefined
  const fail = (error: Error) => {
    gone ??= error
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }
  child.on("error", () => fail(new Error("the profile's MCP server could not be started")))
  child.on("exit", () => {
    fail(new Error("the profile's MCP server stopped"))
    onExit()
  })
  child.stdin.on("error", () => fail(new Error("the profile's MCP server closed its input")))
  child.stderr.setEncoding("utf8")
  let errors = ""
  child.stderr.on("data", (chunk: string) => {
    const lines = (errors + chunk).split("\n")
    errors = lines.pop() ?? ""
    for (const line of lines) if (line.trim()) note(line)
  })
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk
    for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      let message: { id?: unknown; method?: unknown; result?: Record<string, unknown>; error?: { message?: string } }
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      // The child asks nothing of a client today; an answer keeps it from waiting forever if it ever does.
      if (message.method !== undefined && message.id !== undefined) {
        send({ id: message.id, error: { code: -32601, message: "not offered through the all-profiles server" } })
        continue
      }
      if (typeof message.id !== "number") continue
      const waiter = pending.get(message.id)
      if (!waiter) continue
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message ?? "the profile's MCP server refused"))
      else waiter.resolve(message.result ?? {})
    }
  })
  const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
  const request = (method: string, params: object) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (gone) return reject(gone)
      const id = next++
      pending.set(id, { resolve, reject })
      send({ id, method, params })
    })
  const close = () =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      child.once("exit", () => resolve())
      // Ending stdin is how a stdio server is told to finish: it answers what is pending, then exits.
      child.stdin.end()
    })
  const timer = setTimeout(() => fail(new Error("the profile's MCP server did not answer in time")), START_MS)
  return request("initialize", {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: PROXY_CLIENT_NAME, version: "1" },
  })
    .then(() => {
      send({ method: "notifications/initialized" })
      return { request, close }
    })
    .catch(async (error: Error) => {
      await close()
      throw error
    })
    .finally(() => clearTimeout(timer))
}

/** Profile servers started on their first call and closed after a quiet spell, shared by every session. */
const pool = (options: AllProfilesOptions) => {
  const idleMs = options.idleMs ?? CHILD_IDLE_MS
  const note = options.note ?? (() => {})
  const running = new Map<string, { child: Promise<Child>; timer?: NodeJS.Timeout }>()
  const forget = (profile: string, child: Promise<Child>) => {
    const one = running.get(profile)
    if (one?.child !== child) return
    clearTimeout(one.timer)
    running.delete(profile)
  }
  const use = async <T>(profile: string, work: (child: Child) => Promise<T>): Promise<T> => {
    let one = running.get(profile)
    if (!one) {
      const child: Promise<Child> = startChild(
        options.child(profile),
        (line) => note(`${profile}: ${line}`),
        () => forget(profile, child),
      )
      child.catch(() => forget(profile, child))
      one = { child }
      running.set(profile, one)
    }
    clearTimeout(one.timer)
    const entry = one
    try {
      return await work(await entry.child)
    } finally {
      if (running.get(profile) === entry) {
        entry.timer = setTimeout(() => {
          forget(profile, entry.child)
          void entry.child.then((child) => child.close()).catch(() => undefined)
        }, idleMs)
        entry.timer.unref()
      }
    }
  }
  const close = async () => {
    const all = [...running.values()]
    running.clear()
    for (const one of all) clearTimeout(one.timer)
    await Promise.all(all.map((one) => one.child.then((child) => child.close()).catch(() => undefined)))
  }
  return { use, close }
}

/**
 * The child's tool with the one field that picks the profile, required and without a default. Each profile carries
 * its state as the title an app shows in its menu (`oneOf` with `const` and `title`, as MCP's titled enums), and the
 * description repeats it for an app that shows only the description.
 */
export const withProfile = (
  tool: Tool,
  profiles: readonly string[],
  name: string,
  signedIn: (profile: string) => boolean = () => true,
): Tool => {
  const schema = tool.inputSchema as { properties?: Record<string, object>; required?: string[] }
  const out = profiles.filter((profile) => !signedIn(profile))
  const states =
    out.length === 0
      ? ""
      : ` Signed in: ${profiles.filter(signedIn).join(", ") || "none"} · Not signed in: ${out.join(", ")}.`
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        profile: {
          type: "string",
          enum: [...profiles],
          oneOf: profiles.map((profile) => ({
            const: profile,
            title: signedIn(profile) ? profile : `${profile} — not signed in`,
          })),
          description: `Which ${name} account, by its profile. If the owner did not name one, ask which — never guess.${states}`,
        },
        ...schema.properties,
      },
      required: ["profile", ...(schema.required ?? []).filter((field) => field !== "profile")],
    },
  }
}

const refusal = (text: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text }],
})

/**
 * **One server for every profile of a tool** (TASK-26): `<tool> mcp` shows the tools `<tool> <profile> mcp` shows,
 * each with a required `profile`, and runs a call in that profile's own server, started as a child the first time
 * it is needed. The child applies the profile's permissions, keyring, store and audit log, so nothing here decides
 * what a profile may do; this only routes.
 */
export const allProfilesServer = (options: AllProfilesOptions) => {
  const children = pool(options)
  let listed: Promise<Tool[]> | undefined
  // Every profile's server offers the same tools — availability, not the list, follows its permissions — so the
  // list comes from whichever answers first and is kept.
  const tools = (profiles: readonly string[]) => {
    listed ??= children
      .use(profiles.find(signedIn) ?? (profiles[0] as string), (child) => child.request("tools/list", {}))
      .then((answer) => (answer.tools ?? []) as Tool[])
    listed.catch(() => {
      listed = undefined
    })
    return listed
  }
  const signedIn = (profile: string) => options.signedIn?.(profile) ?? true
  const build = (): McpServer => {
    const profiles = [...options.profiles()].sort()
    const server = new McpServer(
      { name: options.command, version: options.version },
      { capabilities: { tools: {} }, instructions: options.instructions },
    )
    server.server.setRequestHandler("tools/list", async () => ({
      tools:
        profiles.length === 0
          ? []
          : (await tools(profiles)).map((one) => withProfile(one, profiles, options.name, signedIn)),
    }))
    const callers = {
      env: options.env ?? process.env,
      client: () => server.server.getClientVersion(),
      connectionId: randomUUID(),
    }
    server.server.setRequestHandler("tools/call", async (request, ctx) => {
      const { name, arguments: given = {}, _meta } = request.params
      const { profile, ...rest } = given as Record<string, unknown>
      if (typeof profile !== "string" || !profiles.includes(profile))
        return refusal(
          `${name} needs "profile", one of: ${profiles.join(", ")}. If the owner did not say which account, ask.`,
        )
      if (!signedIn(profile)) return refusal(options.signIn?.(profile) ?? `profile ${profile} is not signed in.`)
      try {
        return (await children.use(profile, (child) =>
          // Children are shared by every session, so each call names its own caller.
          child.request("tools/call", {
            name,
            arguments: rest,
            _meta: { ..._meta, [CALLER_META_KEY]: callerOf(ctx, name, callers) },
          }),
        )) as CallToolResult
      } catch (error) {
        return refusal(`profile ${profile}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    return server
  }
  return { build, close: () => children.close() }
}

/** Over stdin and stdout until the client closes stdin or the process is told to stop; then the children close. */
export const serveAllProfilesOverStdio = async (
  options: AllProfilesOptions,
  io: { stdin?: Readable; stdout?: Writable; signal?: AbortSignal } = {},
): Promise<void> => {
  const { build, close } = allProfilesServer(options)
  const own = io.stdin !== undefined && io.stdin !== process.stdin
  const wire = answeredWire(io.stdin ?? process.stdin, io.stdout ?? process.stdout)
  const handle = serveStdio(build, {
    transport: new StdioServerTransport(wire.input, wire.output),
    onerror: (error) => options.note?.(`mcp: ${error.message}`),
  })
  const ended = await new Promise<"input" | "stopped">((resolve) => {
    wire.ended.then(() => resolve("input"))
    if (own) io.signal?.addEventListener("abort", () => resolve("stopped"), { once: true })
    else {
      process.once("SIGINT", () => resolve("stopped"))
      process.once("SIGTERM", () => resolve("stopped"))
    }
  })
  try {
    if (ended === "input") await wire.answered()
    wire.release()
    await handle.close()
  } finally {
    await close()
  }
}

/** Over HTTP behind the tunnel, one login for every profile; the caller keeps it running and closes it. */
export const serveAllProfilesOverHttp = async (
  options: AllProfilesOptions,
  http: Omit<HttpOptions, "appName" | "onError">,
) => {
  const { build, close } = allProfilesServer(options)
  const { serveOverHttp } = await import("./http/serve.js")
  const listening = await serveOverHttp(build, {
    ...http,
    appName: options.command,
    onError: (error) => options.note?.(`mcp: ${error.message}`),
  }).catch(async (error: unknown) => {
    await close()
    throw error
  })
  return {
    url: listening.url,
    close: async () => {
      try {
        await listening.close()
      } finally {
        await close()
      }
    },
  }
}
