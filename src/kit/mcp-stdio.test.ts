import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import type { Messenger } from "../cli/messenger/context.js"
import { mcpCommand } from "../cli/messenger/mcp-command.js"
import { pollsCommand } from "../cli/messenger/polls-command.js"
import { run } from "../cli/program.js"
import { settingsFor } from "../cli/settings.js"
import { mcpOverStdio } from "./mcp-stdio.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "test", version: "1" }

const cli = () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-stdio-"))
  const env = {
    CHAT_PROFILE: "default",
    CHAT_CONFIG_DIR: join(root, "config"),
    CHAT_STATE_DIR: join(root, "state"),
    MESSAGING_STORE: join(root, "m.db"),
  }
  const connects: number[] = []
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    chatArgument: "chat",
    connect: async () => {
      connects.push(1)
      throw new Error("no connection in this test")
    },
  }
  return { env, connects, program: { app, commands: () => [mcpCommand(messenger), pollsCommand(messenger)] } }
}

describe("mcpOverStdio", () => {
  it("runs a CLI's mcp over its stdin and stdout through run(), and ends it with stdin", async () => {
    const { env, program } = cli()
    const mcp = await mcpOverStdio((streams) =>
      run(["mcp"], program, { streams: captureStreams(), tty: false, env, ...streams }),
    )

    const tools = await mcp.tools()
    const found = await mcp.call("chat_tools_search", { query: "polls create" })
    const unknown = await mcp.call("chat_write", { command: "no such command", arguments: {} })

    expect(tools).toEqual(expect.arrayContaining(["chat_read", "chat_write", "chat_tools_search"]))
    expect(found.isError).toBe(false)
    expect((found.body as { items: { command: string }[] }).items.map((one) => one.command)).toContain("polls create")
    expect(unknown.isError).toBe(true)
    expect(await mcp.close()).toBe(0)
  })

  it("fails at once when the CLI exits before it answers", async () => {
    await expect(mcpOverStdio(async () => 2)).rejects.toThrow("exited before it answered")
  })
})
