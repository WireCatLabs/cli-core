import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { captureStreams } from "@wirecat/cli-base"
import { memoryKeyring } from "@wirecat/cli-base/testing"
import { describe, expect, it } from "vitest"
import { fakeProfileServer } from "../../testing/fake-mcp-child.js"
import { sharedCommands } from "../../testing/shared-program.js"
import { provide } from "../context.js"
import { createProgram } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"

const app = {
  command: "chat",
  appName: "chat-cli",
  envPrefix: "CHAT",
  description: "A test messenger",
  version: "1.0.0",
}

const messenger: Messenger = {
  app,
  provider: "chat",
  name: "Chat",
  resolveSettings: settingsFor(app).resolveSettings,
  connect: async () => {
    throw new Error("the server of every profile never connects itself")
  },
  chatArgument: "a chat",
}

/** `chat mcp` as an agent runs it: requests on stdin, then stdin closes; the answers are on stdout. */
const serve = async (requests: object[], { profiles = ["work", "personal"], argv = ["mcp"] } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "mcp-every-"))
  const env = {
    CHAT_CONFIG_DIR: join(root, "config"),
    CHAT_STATE_DIR: join(root, "state"),
    MESSAGING_STORE: join(root, "m.db"),
  }
  mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
  writeFileSync(
    join(env.CHAT_CONFIG_DIR, "config.json"),
    JSON.stringify({ profiles: Object.fromEntries(profiles.map((one) => [one, {}])) }),
  )
  const { script, log } = fakeProfileServer()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  let written = ""
  stdout.on("data", (chunk) => {
    written += chunk
  })
  const streams = captureStreams()
  const program = createProgram({ app, commands: () => sharedCommands(messenger) })
  provide(program, {
    streams,
    tty: false,
    env,
    app,
    keyring: memoryKeyring(),
    stdin,
    stdout,
    mcp: { execPath: process.execPath, scriptPath: script },
  } as Parameters<typeof provide>[1])
  for (const request of requests) stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...request })}\n`)
  stdin.end()
  const failure = await program.parseAsync(argv, { from: "user" }).then(
    () => undefined,
    (error: Error) => error,
  )
  const answers = written
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> })
  return { answers, log: () => readFileSync(log, "utf8"), failure, stderr: streams.stderr }
}

const HANDSHAKE = [
  {
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
  },
  { method: "notifications/initialized" },
]

describe("chat mcp, with no profile", () => {
  it("serves every profile: each tool takes one, and a call runs in `chat <profile> mcp`", async () => {
    const { answers, log } = await serve([
      ...HANDSHAKE,
      { id: 2, method: "tools/list" },
      { id: 3, method: "tools/call", params: { name: "chat_read", arguments: { profile: "work", command: "inbox" } } },
    ])
    const [hello, listed, called] = [1, 2, 3].map((id) => answers.find((one) => one.id === id)?.result)
    expect(String(hello?.instructions)).toContain(
      'accounts, one per profile: personal, work. Every tool takes "profile"',
    )
    expect(listed).toMatchObject({
      tools: [{ name: "chat_read", inputSchema: { required: ["profile", "command"] } }],
    })
    expect(JSON.parse(((called?.content ?? []) as { text: string }[])[0]?.text ?? "")).toMatchObject({
      profile: "work",
      arguments: { command: "inbox" },
    })
    expect(log()).toContain("start work mcp")
  })

  it("passes a stricter permission on to every profile's server", async () => {
    const { log } = await serve(
      [
        ...HANDSHAKE,
        {
          id: 2,
          method: "tools/call",
          params: { name: "chat_read", arguments: { profile: "personal", command: "x" } },
        },
      ],
      { argv: ["mcp", "--permission", "messages.send=deny"] },
    )
    expect(log()).toContain("start personal mcp --permission messages.send=deny")
  })

  it("says so when there is no profile on this computer yet", async () => {
    const { failure } = await serve(HANDSHAKE, { profiles: [] })
    expect(failure?.message ?? "").toContain("no chat profile on this computer yet")
  })
})
