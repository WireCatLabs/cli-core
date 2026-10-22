import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
import { configCommand } from "../config-command.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import { messagesCommand } from "./messages-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "Test", version: "1.0.0" }

const fixture = (permission: string) => {
  const root = mkdtempSync(join(tmpdir(), "permission-errors-"))
  const env = {
    CHAT_CONFIG_DIR: join(root, "config"),
    CHAT_STATE_DIR: join(root, "state"),
    MESSAGING_STORE: join(root, "messages.db"),
  }
  mkdirSync(env.CHAT_CONFIG_DIR)
  writeFileSync(
    join(env.CHAT_CONFIG_DIR, "config.json"),
    JSON.stringify({
      profiles: {
        personal: { permissions: { [permission]: "deny" } },
      },
    }),
  )
  const connect = vi.fn<Messenger["connect"]>()
  const config = settingsFor(app)
  const messenger: Messenger = {
    app,
    provider: "chat",
    connect,
    resolveSettings: config.resolveSettings,
    chatArgument: "a chat",
  }
  const execute = async (words: string[]) => {
    const streams = captureStreams()
    const code = await run(
      ["personal", ...words, "--json", "--no-record"],
      {
        app,
        commands: () => [messagesCommand(messenger), configCommand(app, config)],
      },
      { env, streams, tty: false },
    )
    return { code, output: streams.stdout.join(""), diagnostic: streams.stderr.join("\n") }
  }
  return { execute, connect }
}

describe("unknown configured permission keys", () => {
  it.each(["messages.sedn", "messages.pins.cretae"])("refuses %s before a read or write connects", async (key) => {
    const { execute, connect } = fixture(key)
    for (const words of [
      ["messages", "list", "7"],
      ["messages", "send", "7", "hello"],
    ]) {
      const result = await execute(words)
      expect(result.code).not.toBe(0)
      expect(result.output + result.diagnostic).toContain("configuration_error")
      expect(result.output + result.diagnostic).toContain(`permissions.${key} names no command`)
      expect(result.output + result.diagnostic).toContain(`chat personal config unset permissions.${key}`)
    }
    expect(connect).not.toHaveBeenCalled()
  })

  it("keeps config unset available so the owner can repair the file", async () => {
    const { execute, connect } = fixture("messages.sedn")
    expect((await execute(["config", "unset", "permissions.messages.sedn"])).code).toBe(0)
    expect(connect).not.toHaveBeenCalled()
  })
})
