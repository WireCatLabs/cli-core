import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import type { Command } from "commander"
import { describe, expect, it } from "vitest"
import { sharedProgram } from "../testing/shared-program.js"
import { createProgram, run } from "./program.js"

const walk = (command: Command): Command[] => [command, ...command.commands.flatMap(walk)]

describe("canonical command paths", () => {
  it("mounts no compatibility command aliases or hidden legacy paths", () => {
    const program = createProgram(sharedProgram)
    for (const command of walk(program)) expect(command.aliases()).toEqual([])
    const contacts = program.commands.find((command) => command.name() === "contacts")
    expect(contacts?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["info", "events", "aliases"]),
    )
    const models = program.commands.find((command) => command.name() === "models")
    expect(models?.commands.map((command) => command.name()).sort()).toEqual(["download", "keys", "list"])
  })

  it.each([
    ["contacts profile", "contacts info"],
    ["metadata refresh", "metadata sync"],
    ["attachments text set", "attachments update"],
    ["models audio list", "models list kind:audio"],
  ])("refuses %s with replacement guidance before opening an account", async (old, replacement) => {
    const root = mkdtempSync(join(tmpdir(), "canonical-path-"))
    const env = {
      CHAT_CONFIG_DIR: join(root, "config"),
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CACHE_DIR: join(root, "cache"),
      MESSAGING_STORE: join(root, "store.sqlite"),
    }
    const streams = captureStreams()
    const code = await run(["synthetic", ...old.split(" "), "--json"], sharedProgram, { streams, tty: false, env })
    expect(code).toBe(2)
    expect(streams.stdout).toEqual([])
    const error = JSON.parse(streams.stderr[0] ?? "null").error
    expect(error.code).toBe("validation_error")
    expect(error.message).toContain(replacement)
    expect(existsSync(env.MESSAGING_STORE)).toBe(false)
  })
})
