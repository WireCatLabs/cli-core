import { type ChildProcess, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { captureStreams } from "@wirecat/cli-base"
import { afterEach, describe, expect, it } from "vitest"
import { alive } from "../../background/processes.js"
import type { ServerSystem } from "../../background/system.js"
import { httpLockFile, readHttpLock } from "../../mcp/http/state.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import { httpTokenFile, mcpCommand } from "./mcp-command.js"

const app = { command: "chat", appName: "chat-cli", envPrefix: "CHAT", description: "test", version: "1" }
const messenger: Messenger = {
  app,
  provider: "chat",
  resolveSettings: settingsFor(app).resolveSettings,
  chatArgument: "chat",
  connect: async () => {
    throw new Error("must not connect")
  },
}

/** Stands in for `chat mcp --http`: writes the lock as the real server does, then waits to be stopped. */
const SERVER = `
const { writeFileSync } = require("node:fs")
const [lock, mode] = process.argv.slice(1)
if (mode === "fail") { console.error("port 8765 is in use — pass another with --port"); process.exit(1) }
writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), port: 8765,
  publicUrl: "https://laptop.example.ts.net/", listeningAt: new Date().toISOString(), version: "1",
  loginCode: "ABCD-EFGH", loginCodeExpiresAt: new Date(Date.now() + 600000).toISOString() }), { mode: 0o600 })
process.on("SIGTERM", () => process.exit(0))
setInterval(() => {}, 1000)
`

const children: ChildProcess[] = []
afterEach(() => {
  for (const child of children.splice(0)) if (child.pid && alive(child.pid)) child.kill("SIGKILL")
})

const background = (env: NodeJS.ProcessEnv, args: string[] = [], log = "ignore" as "ignore" | number) => {
  const child = spawn(process.execPath, ["-e", SERVER, ...args], { env, stdio: ["ignore", log, log] })
  children.push(child)
  return child
}

const setup = (mode: "serve" | "fail" = "serve") => {
  const root = mkdtempSync(join(tmpdir(), "mcp-server-"))
  const env = {
    PATH: process.env.PATH ?? "",
    CHAT_CONFIG_DIR: join(root, "config"),
    CHAT_STATE_DIR: join(root, "state"),
    CHAT_PROFILE: "personal",
    CHAT_TIMEOUT: "30s",
  }
  const tokenFile = httpTokenFile(app, "personal", env)
  const lockFile = httpLockFile(tokenFile)
  mkdirSync(dirname(lockFile), { recursive: true })
  const launched: { argv: string[]; env: NodeJS.ProcessEnv }[] = []
  const system: ServerSystem = {
    platform: process.platform,
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    entry: [process.execPath, "chat.js"],
    uid: 0,
    spawn: (argv, childEnv, log) => {
      launched.push({ argv, env: childEnv })
      return background(childEnv, [lockFile, mode], openSync(log, "a")).pid ?? 0
    },
    pause: () => sleep(20),
  }
  const cli = async (argv: string[]) => {
    const streams = captureStreams()
    const code = await run(
      ["personal", ...argv, "--json"],
      { app, commands: () => [mcpCommand(messenger)] },
      { streams, tty: false, env, system },
    )
    const out = streams.stdout.join("")
    return { code, item: out ? JSON.parse(out).item : undefined, error: streams.stderr.join("") }
  }
  return { env, tokenFile, lockFile, launched, cli }
}

const PUBLIC = ["--public-url", "https://laptop.example.ts.net"]

describe("mcp server", () => {
  it("starts mcp --http apart from the shell with the marker, and answers with the port, address and login code", async () => {
    const { cli, launched } = setup()

    const { code, item } = await cli(["mcp", "server", "start", ...PUBLIC, "--port", "9001"])

    expect(code).toBe(0)
    expect(item).toMatchObject({
      profile: "personal",
      started: true,
      running: true,
      by: "server",
      port: 8765,
      public_url: "https://laptop.example.ts.net/",
      connector_url: "https://laptop.example.ts.net/mcp",
      login_code: { code: "ABCD-EFGH", expires_at: expect.any(String) },
    })
    expect(launched[0]?.argv).toEqual([
      "mcp",
      "--http",
      "--port",
      "9001",
      "--public-url",
      "https://laptop.example.ts.net",
    ])
    expect(launched[0]?.env).toMatchObject({ CHAT_MCP_HTTP: "personal", CHAT_PROFILE: "personal" })
    expect(launched[0]?.env.CHAT_TIMEOUT).toBeUndefined()
  })

  it("refuses to start a second server and starts nothing", async () => {
    const { cli, launched } = setup()
    await cli(["mcp", "server", "start", ...PUBLIC])

    const { code, item } = await cli(["mcp", "server", "start", ...PUBLIC])

    expect(code).toBe(0)
    expect(item).toMatchObject({ started: false, running: true })
    expect(launched).toHaveLength(1)
  })

  it("says why when the server stops before it listens", async () => {
    const { cli } = setup("fail")

    const { code, error } = await cli(["mcp", "server", "start", ...PUBLIC])

    expect(code).not.toBe(0)
    expect(JSON.parse(error.trim().split("\n").at(-1) ?? "null").error.message).toMatch(/port 8765 is in use/)
  })

  it("needs the tunnel's address", async () => {
    const { cli, launched } = setup()

    const { code } = await cli(["mcp", "server", "start"])

    expect(code).not.toBe(0)
    expect(launched).toHaveLength(0)
  })

  it("reports status with the apps logged in, and stops only the server it started", async () => {
    const { cli, tokenFile, lockFile } = setup()
    const seconds = Math.floor(Date.now() / 1000)
    writeFileSync(
      tokenFile,
      JSON.stringify({
        clients: [{ id: "x", name: "Claude", redirectUris: [], authMethod: "none", issuedAt: 0 }],
        tokens: [{ hash: "h", kind: "refresh", clientId: "x", expiresAt: seconds + 1000 }],
      }),
    )
    await cli(["mcp", "server", "start", ...PUBLIC])
    const pid = readHttpLock(lockFile)?.pid ?? 0

    const status = await cli(["mcp", "server", "status"])
    expect(status.item).toMatchObject({
      running: true,
      by: "server",
      pid,
      login_code: { code: "ABCD-EFGH" },
      clients: [{ claimed_name: "Claude", last_login_at: expect.any(String) }],
    })

    const stopped = await cli(["mcp", "server", "stop"])
    expect(stopped.item).toMatchObject({ stopped: true, pid })
    expect(alive(pid)).toBe(false)
  })

  it("calls a lock left by a dead server stale, stops nothing, and starts over it", async () => {
    const { cli, lockFile, launched } = setup()
    const gone = background({ PATH: process.env.PATH ?? "" }, [lockFile, "fail"])
    await new Promise((resolve) => gone.once("exit", resolve))
    writeFileSync(
      lockFile,
      JSON.stringify({ pid: gone.pid, startedAt: "2026-10-26T09:00:00Z", port: 8765, publicUrl: "https://a.example/" }),
    )

    expect((await cli(["mcp", "server", "status"])).item).toMatchObject({
      running: false,
      stale: { pid: gone.pid },
      clients: [],
    })
    expect((await cli(["mcp", "server", "stop"])).item).toMatchObject({ stopped: false })
    expect((await cli(["mcp", "server", "start", ...PUBLIC])).item).toMatchObject({ started: true })
    expect(launched).toHaveLength(1)
  })

  it.each([
    ["started by hand", {}],
    ["a serve of the same profile", { CHAT_SERVER: "personal" }],
    ["another profile's server", { CHAT_MCP_HTTP: "work" }],
  ])("refuses to stop a process it cannot prove it started: %s", async (_, marker) => {
    const { cli, lockFile } = setup()
    const foreign = background({ PATH: process.env.PATH ?? "", ...marker }, [lockFile, "serve"])
    while (!readHttpLock(lockFile)) await sleep(10)

    const status = await cli(["mcp", "server", "status"])
    const stop = await cli(["mcp", "server", "stop"])

    expect(status.item).toMatchObject({ running: true, by: "hand" })
    expect(stop.code).toBe(2)
    expect(stop.error).toMatch(/was not started by `chat personal mcp server start`/)
    expect(alive(foreign.pid ?? 0)).toBe(true)
  })
})
