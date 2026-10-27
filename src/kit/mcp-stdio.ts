import { PassThrough } from "node:stream"

export interface McpStdioStreams {
  stdin: PassThrough
  stdout: PassThrough
}

export interface McpToolResult {
  isError: boolean
  /** The first text content, parsed when it is JSON. */
  body: unknown
}

export interface McpStdio {
  /** One JSON-RPC request; resolves with its `result`, rejects with its `error`'s message. */
  request: (method: string, params?: object) => Promise<unknown>
  /** `tools/call`, the way an agent calls a tool. */
  call: (name: string, args?: Record<string, unknown>) => Promise<McpToolResult>
  /** The names `tools/list` gives. */
  tools: () => Promise<string[]>
  /** Ends stdin, as a client does when it goes, and resolves with the CLI's exit code. */
  close: () => Promise<number>
}

const parsedOrText = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * A CLI's `mcp serve` driven over its stdin and stdout, through its own `run()`, with no process and no SDK:
 * `start` passes the two streams to `run(["<profile>", "mcp", "serve"], { ...yourOptions, ...streams })`. It has
 * already answered `initialize` when this resolves.
 */
export const mcpOverStdio = async (
  start: (streams: McpStdioStreams) => Promise<number>,
  { protocolVersion = "2025-06-18" }: { protocolVersion?: string } = {},
): Promise<McpStdio> => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const waiting = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>()
  let next = 1
  let buffered = ""
  stdout.setEncoding("utf8")
  stdout.on("data", (chunk: string) => {
    buffered += chunk
    const lines = buffered.split("\n")
    buffered = lines.pop() ?? ""
    for (const line of lines) {
      if (line.trim() === "") continue
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } }
      const pending = message.id === undefined ? undefined : waiting.get(message.id)
      if (!pending) continue
      waiting.delete(message.id as number)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    }
  })
  const write = (message: object) => stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
  // A CLI that fails to start, or stops, must fail the calls still waiting rather than leave them hanging.
  const exited = start({ stdin, stdout }).finally(() => {
    for (const [id, pending] of waiting) {
      waiting.delete(id)
      pending.reject(new Error("the CLI exited before it answered"))
    }
  })
  exited.catch(() => {})

  const request = (method: string, params?: object) =>
    new Promise<unknown>((resolve, reject) => {
      const id = next++
      waiting.set(id, { resolve, reject })
      write({ id, method, ...(params === undefined ? {} : { params }) })
    })

  await request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "0" } })
  write({ method: "notifications/initialized" })

  return {
    request,
    call: async (name, args = {}) => {
      const result = (await request("tools/call", { name, arguments: args })) as {
        isError?: boolean
        content?: { type: string; text?: string }[]
      }
      const text = result.content?.find((one) => one.type === "text")?.text
      return { isError: result.isError === true, body: text === undefined ? null : parsedOrText(text) }
    },
    tools: async () => ((await request("tools/list")) as { tools: { name: string }[] }).tools.map(({ name }) => name),
    close: async () => {
      stdin.end()
      return exited
    },
  }
}
