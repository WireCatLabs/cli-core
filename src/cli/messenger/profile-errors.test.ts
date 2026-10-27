import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import { rememberAccount } from "./accounts.js"
import { chatsCommand } from "./chats-command.js"
import type { Messenger } from "./context.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "Test", version: "1.0.0" }

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "profile-errors-"))
  const env = {
    CHAT_CONFIG_DIR: join(root, "config"),
    CHAT_STATE_DIR: join(root, "state"),
    MESSAGING_STORE: join(root, "messages.db"),
  }
  mkdirSync(env.CHAT_CONFIG_DIR)
  writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify({ profiles: { alpha: {}, beta: {} } }))
  const connect = vi.fn<Messenger["connect"]>()
  const read = async (profile: string, history: Messenger["history"], more: Partial<Messenger> = {}) => {
    const messenger: Messenger = {
      ...more,
      app,
      provider: "chat",
      history,
      connect,
      resolveSettings: settingsFor(app).resolveSettings,
      chatArgument: "a chat",
    }
    const streams = captureStreams()
    const code = await run(
      [profile, "chats", "list", "--offline", "--json", "--no-record"],
      { app, commands: () => [chatsCommand(messenger)] },
      { env, streams, tty: false },
    )
    return { code, error: JSON.parse(streams.stdout[0] ?? streams.stderr.join("\n")).error }
  }
  return { read, connect, env }
}

describe("unrecorded profile errors", () => {
  it.each(["store", "server"] as const)("lists configured profiles for a typo with %s history", async (history) => {
    const { read, connect } = fixture()
    const result = await read("nosuch", history)
    expect(result.code).toBe(6)
    expect(result.error).toMatchObject({
      code: "not_found",
      message: 'no profile named "nosuch" — profiles here: alpha, beta',
      details: { profiles: ["alpha", "beta"] },
    })
    expect(connect).not.toHaveBeenCalled()
  })

  it("marks a listed profile that is not signed in", async () => {
    const { read } = fixture()
    const result = await read("nosuch", "store", {
      profileState: (profile) => (profile === "beta" ? "signed-out" : "signed-in"),
    })
    expect(result.error.message).toBe('no profile named "nosuch" — profiles here: alpha, beta (not signed in)')
    expect(result.error.details.profiles).toEqual(["alpha", "beta"])
  })

  it("also offers profiles remembered outside configuration", async () => {
    const { read, env } = fixture()
    rememberAccount(app, "gamma", "500", env)
    expect((await read("nosuch", "store")).error.details.profiles).toEqual(["alpha", "beta", "gamma"])
  })

  it.each(["store", "server"] as const)(
    "keeps the no-data guidance for a configured profile with %s history",
    async (history) => {
      const { read, connect } = fixture()
      const result = await read("alpha", history)
      expect(result.code).toBe(6)
      expect(result.error.message).toContain('nothing recorded for profile "alpha" yet')
      expect(result.error.message).not.toContain("no profile named")
      expect(connect).not.toHaveBeenCalled()
    },
  )
})
