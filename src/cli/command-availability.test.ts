import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { describe, expect, it, vi } from "vitest"
import { commandsCommand } from "./commands-command.js"
import { grantsAuthority, LOCAL_WRITE, REMOTE_READ, REMOTE_WRITE } from "./effects.js"
import { run } from "./program.js"

const app = { command: "app", appName: "app-cli", envPrefix: "APP", description: "Discovery", version: "1" }

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "availability-"))
  const env = { APP_CONFIG_DIR: root, APP_STATE_DIR: join(root, "state"), MESSAGING_STORE: join(root, "messages.db") }
  const path = join(root, "config.json")
  writeFileSync(path, JSON.stringify({ profiles: { limited: { permissions: { "messages.send": "deny" } } } }))
  const action = vi.fn()
  const definition = {
    app,
    commands: () => [
      commandsCommand(app),
      new Command("bot").addCommand(
        new Command("api").addCommand(annotate(new Command("get-me").action(action), { effects: REMOTE_READ })),
      ),
      new Command("config").addCommand(
        grantsAuthority(annotate(new Command("set").action(action), { effects: LOCAL_WRITE })),
      ),
      new Command("messages")
        .addCommand(annotate(new Command("list").action(action), { effects: REMOTE_READ }))
        .addCommand(
          annotate(new Command("send").argument("<chat>").argument("<text>").action(action), { effects: REMOTE_WRITE }),
        ),
    ],
  }
  const call = async (args: string[], tty = false) => {
    const streams = captureStreams()
    const code = await run(args, definition, { streams, env, tty })
    expect(action).not.toHaveBeenCalled()
    return { code, stdout: streams.stdout.join("\n"), stderr: streams.stderr.join("\n") }
  }
  return { call, path }
}

describe("profile-aware CLI discovery", () => {
  it("retains denied commands and their arguments with a permission explanation", async () => {
    const { call } = fixture()
    const result = await call(["limited", "commands", "messages", "--json"])
    expect(result.code).toBe(0)
    const commands = JSON.parse(result.stdout).commands[0].commands
    expect(commands.map((one: { name: string }) => one.name)).toEqual(["list", "send"])
    expect(commands[0].availability).toEqual({ available: true })
    expect(commands[1]).toMatchObject({
      availability: { available: false, permission: "messages.send", reason: expect.any(String) },
      arguments: [{ name: "chat" }, { name: "text" }],
    })
    const projected = await call(["limited", "commands", "messages", "--json=availability"])
    expect(projected.code).toBe(0)
    expect(JSON.parse(projected.stdout).commands[0].commands[1]).toMatchObject({
      name: "send",
      availability: { available: false },
    })
    const info = await call(["limited", "commands", "info", "messages", "send", "--json"])
    expect(info.code).toBe(0)
    expect(JSON.parse(info.stdout).availability).toMatchObject({ available: false, permission: "messages.send" })
  })

  it("keeps MCP-only authority and raw API gates out of terminal availability", async () => {
    const { call } = fixture()
    for (const path of [
      ["bot", "api", "get-me"],
      ["config", "set"],
    ]) {
      const result = await call(["limited", "commands", "info", ...path, "--json"])
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout).availability).toEqual({ available: true })
    }
  })

  it("marks a denied command in help and text discovery without executing it", async () => {
    const { call } = fixture()
    const help = await call(["limited", "messages", "send", "--help"])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain("Availability:")
    expect(help.stdout).toContain("unavailable")
    expect(help.stdout).toContain("messages.send")
    expect(help.stdout).toContain("<text>")
    const text = await call(["limited", "commands", "messages"], true)
    expect(text.stdout).toContain("messages send")
    expect(text.stdout).toContain("[unavailable:")
  })

  it("keeps unprofiled discovery independent of configuration, and help usable with a broken config", async () => {
    const { call, path } = fixture()
    writeFileSync(path, "{broken")
    const staticList = await call(["commands", "messages", "--json"])
    expect(staticList.code).toBe(0)
    expect(JSON.parse(staticList.stdout).commands[0].commands.map((one: { name: string }) => one.name)).toEqual([
      "list",
      "send",
    ])
    expect(staticList.stdout).not.toContain('"availability"')
    const help = await call(["limited", "messages", "send", "--help"])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain("<text>")
  })
})
