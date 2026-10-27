import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
import { serveOverHttpUntilStopped } from "../../mcp/server.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import { mcpCommand } from "./mcp-command.js"

vi.mock("../../mcp/server.js", () => ({ serveOverHttpUntilStopped: vi.fn(async () => {}) }))
const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "test", version: "1" }
const cli = async (argv: string[]) => {
  vi.mocked(serveOverHttpUntilStopped).mockClear()
  const root = mkdtempSync(join(tmpdir(), "mcp-policy-"))
  const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_PROFILE: "default", CHAT_STATE_DIR: join(root, "state") }
  mkdirSync(env.CHAT_CONFIG_DIR)
  const file = join(env.CHAT_CONFIG_DIR, "config.json")
  const original = JSON.stringify({ defaults: { permissions: { "messages.send": "deny" } } })
  writeFileSync(file, original)
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    chatArgument: "chat",
    connect: async () => {
      throw new Error("must not connect")
    },
  }
  const streams = captureStreams()
  const code = await run(argv, { app, commands: () => [mcpCommand(messenger)] }, { streams, tty: false, env })
  expect(readFileSync(file, "utf8")).toBe(original)
  return { code, streams }
}

describe("HTTP MCP startup", () => {
  it("passes the effective overrides without saving the profile", async () => {
    const { code, streams } = await cli([
      "mcp",
      "serve",
      "--http",
      "--public-url",
      "https://device.example",
      "--permission",
      "messages.send=deny",
      "--permission",
      "chats=readonly",
    ])
    expect(code).toBe(0)
    expect(streams.stdout).toEqual([])
    expect(serveOverHttpUntilStopped).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        settings: expect.objectContaining({
          permissions: expect.objectContaining({ "messages.send": "deny", chats: "readonly" }),
        }),
      }),
      expect.anything(),
      {},
      expect.not.objectContaining({ confirmation: expect.anything() }),
    )
  })
  it("preserves permission overrides in a generated stdio configuration", async () => {
    const { code, streams } = await cli(["mcp", "config", "--permission", "chats=readonly", "--json"])
    expect(code).toBe(0)
    const entry = JSON.parse(streams.stdout.join("")).item.config
    expect(entry.mcpServers["chat-default"].args).toEqual(expect.arrayContaining(["--permission", "chats=readonly"]))
  })
  it("refuses at startup an override that would loosen the profile, naming the key", async () => {
    const { code, streams } = await cli(["mcp", "serve", "--http", "--permission", "messages.send=allow", "--json"])
    expect(code).toBe(2)
    expect(JSON.parse(streams.stderr.at(-1) ?? "null")).toMatchObject({
      error: { code: "validation_error", message: expect.stringContaining("messages.send") },
    })
    expect(serveOverHttpUntilStopped).not.toHaveBeenCalled()
  })
  it.each([["--http", "--permission", "messages.send=yes"]])(
    "rejects invalid options before starting: %j",
    async (...args) => {
      const { code } = await cli(["mcp", "serve", ...args, "--json"])
      expect(code).not.toBe(0)
      expect(serveOverHttpUntilStopped).not.toHaveBeenCalled()
    },
  )
})
