import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import { mcpCommand, redactTail } from "./mcp-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "A test", version: "1.0.0" }

const doctorOf = async (script: string) => {
  const root = mkdtempSync(join(tmpdir(), "mcp-doctor-"))
  const scriptPath = join(root, "server.mjs")
  writeFileSync(scriptPath, script)
  const messenger: Messenger = {
    app,
    provider: "chat",
    resolveSettings: settingsFor(app).resolveSettings,
    connect: async () => {
      throw new Error("mcp doctor must not connect")
    },
    chatArgument: "a chat",
  }
  const streams = captureStreams()
  const code = await run(["mcp", "doctor", "--json"], { app, commands: () => [mcpCommand(messenger)] }, {
    streams,
    tty: false,
    env: {
      HOME: root,
      CHAT_PROFILE: "default",
      CHAT_STATE_DIR: join(root, "state"),
      CHAT_CONFIG_DIR: join(root, "config"),
    },
    mcp: { execPath: process.execPath, scriptPath },
  } as Parameters<typeof run>[2])
  return { code, root, stderr: streams.stderr.join("\n") }
}

describe("mcp doctor", () => {
  it("**shows the end of a server's stderr when it fails to start**, with the home folder, ids and tokens hidden", async () => {
    const { code, root, stderr } = await doctorOf(
      [
        "for (let i = 0; i < 40; i++) console.error('noise ' + i)",
        "console.error('cannot open ' + (process.env.HOME ?? process.env.USERPROFILE) + '/state/session for 123456789')",
        "console.error('token abcdefghijklmnopqrstuvwxyz0123456789ABCD')",
        "process.exit(1)",
      ].join("\n"),
    )

    expect(code).not.toBe(0)
    const { error } = JSON.parse(stderr)
    expect(error.message).toContain("exited before answering")
    expect(error.message).toContain("cannot open ~/state/session for [number]")
    expect(error.message).toContain("token [hidden]")
    expect(error.message).not.toContain("noise 5\n")
    expect(error.message).not.toContain(root)
  })

  it("keeps only the last lines, capped in length", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(200)}`).join("\n")
    const tail = redactTail(text, undefined)
    expect(tail.length).toBeLessThanOrEqual(2000)
    expect(tail).toContain("line 99")
    expect(tail).not.toContain("line 70 ")
  })

  it("makes terminal control codes visible", () => {
    expect(redactTail("\u001b[2Kgone", undefined)).toBe("\\x1b[2Kgone")
  })
})
