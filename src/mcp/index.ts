import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import crossSpawn from "cross-spawn"

export type McpClient = "codex" | "claude-code"

export interface StdioEntry {
  type: "stdio"
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface CommandResult {
  status: number | null
  error?: Error
  stdout: string
  stderr: string
}

export type RunCommand = (file: string, args: string[]) => CommandResult

const realRun: RunCommand = (file, args) => {
  const result = crossSpawn.sync(file, args, { encoding: "utf8", timeout: 10_000, maxBuffer: 256_000 })
  return { status: result.status, error: result.error, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

const executable = (client: McpClient): string => (client === "codex" ? "codex" : "claude")

export const setupArguments = (client: McpClient, name: string, entry: StdioEntry): string[] => {
  const variables = Object.entries(entry.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`])
  if (client === "codex") return ["mcp", "add", name, ...variables, "--", entry.command, ...entry.args]
  return ["mcp", "add", "--scope", "user", name, ...variables, "--", entry.command, ...entry.args]
}

export const installStdioEntry = (
  client: McpClient,
  name: string,
  entry: StdioEntry,
  { run = realRun }: { run?: RunCommand } = {},
): { client: McpClient; name: string; command: string[] } => {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) throw new Error("the MCP name must be letters, digits, _ or -")
  if (!entry.command || entry.args.some((arg) => arg.includes("\0"))) throw new Error("invalid MCP command")
  const file = executable(client)
  const existing = run(file, ["mcp", "get", name, ...(client === "codex" ? ["--json"] : [])])
  if (existing.error) throw new Error(`${file} is not installed or could not be started`)
  if (existing.status === 0) throw new Error(`${name} is already configured in ${file}; remove it there first`)
  if (existing.status !== 0 && !/No MCP server named/i.test(existing.stdout + existing.stderr)) {
    throw new Error(`${file} could not check its MCP configuration`)
  }
  const args = setupArguments(client, name, entry)
  const added = run(file, args)
  if (added.status !== 0 || added.error) throw new Error(`${file} could not add ${name}`)
  return { client, name, command: [entry.command, ...entry.args] }
}

export interface ProbeResult {
  tools: string[]
  potentialWrites: string[]
}

export const probeStdio = async (
  entry: StdioEntry,
  {
    timeoutMs = 10_000,
    start = (file: string, args: string[], env: NodeJS.ProcessEnv) => spawn(file, args, { env, stdio: "pipe" }),
  }: {
    timeoutMs?: number
    start?: (file: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams
  } = {},
): Promise<ProbeResult> => {
  const child = start(entry.command, entry.args, { ...process.env, ...entry.env })
  let buffer = ""
  let timer: NodeJS.Timeout | undefined
  const pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (reason: Error) => void }
  >()
  const request = (id: number, method: string, params: object) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })
  const fail = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }
  child.on("error", () => fail(new Error("the MCP server could not be started")))
  child.on("exit", () => fail(new Error("the MCP server exited before answering")))
  child.stdin.on("error", () => fail(new Error("the MCP server closed its input")))
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk
    if (buffer.length > 1_000_000) return fail(new Error("the MCP server sent too much output"))
    for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      try {
        const value = JSON.parse(line) as { id?: unknown; result?: Record<string, unknown>; error?: unknown }
        if (typeof value.id !== "number") continue
        const waiter = pending.get(value.id)
        if (!waiter) continue
        pending.delete(value.id)
        if (value.error) waiter.reject(new Error("the MCP server rejected the handshake"))
        else waiter.resolve(value.result ?? {})
      } catch {
        fail(new Error("the MCP server sent invalid JSON"))
      }
    }
  })
  try {
    timer = setTimeout(() => fail(new Error("the MCP server did not answer in time")), timeoutMs)
    await request(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "cli-core-mcp-doctor", version: "1" },
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
    const result = await request(2, "tools/list", {})
    const tools = result.tools
    if (!Array.isArray(tools)) throw new Error("the MCP server returned no tool list")
    const named = tools.filter(
      (item): item is { name: string; annotations?: { readOnlyHint?: boolean } } =>
        item !== null && typeof item === "object" && "name" in item && typeof item.name === "string",
    )
    if (named.length !== tools.length) throw new Error("the MCP server returned an invalid tool list")
    return {
      tools: named.map((item) => item.name),
      potentialWrites: named.filter((item) => item.annotations?.readOnlyHint !== true).map((item) => item.name),
    }
  } finally {
    if (timer) clearTimeout(timer)
    pending.clear()
    child.stdin.end()
    child.kill()
  }
}
