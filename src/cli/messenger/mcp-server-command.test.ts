import { type ChildProcess, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { CliError, captureStreams } from "@wirecat/cli-base"
import { Command } from "commander"
import { afterEach, describe, expect, it } from "vitest"
import { restartMcpServers } from "../../background/after-upgrade.js"
import { alive, carries } from "../../background/processes.js"
import type { ServerSystem } from "../../background/system.js"
import { httpLaunchFile, httpLockFile, readHttpLaunch, readHttpLock } from "../../mcp/http/state.js"
import { mcpServerCommand } from "../mcp-server-command.js"
import { run } from "../program.js"
import { settingsFor } from "../settings.js"
import type { Messenger } from "./context.js"
import { ALL_PROFILES, httpTokenFile, mcpCommand } from "./mcp-command.js"

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

/** Stands in for `chat mcp serve --http`: writes the lock as the real server does, then waits to be stopped. */
const SERVER = `
const { writeFileSync } = require("node:fs")
const [lock, mode, publicUrl = "https://laptop.example.ts.net/"] = process.argv.slice(1)
if (mode === "fail") { console.error("port 8765 is in use — pass another with --port"); process.exit(1) }
writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), port: 8765,
  publicUrl, listeningAt: new Date().toISOString(), version: process.env.FAKE_VERSION ?? "1",
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

const setup = (
  mode: "serve" | "fail" = "serve",
  {
    every = false,
    publicUrl,
    mcp = () => mcpCommand(messenger),
  }: { every?: boolean; publicUrl?: string; mcp?: (tokenFile: string, env: NodeJS.ProcessEnv) => Command } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "mcp-server-"))
  const env = {
    PATH: process.env.PATH ?? "",
    CHAT_CONFIG_DIR: join(root, "config"),
    CHAT_STATE_DIR: join(root, "state"),
    ...(every ? {} : { CHAT_PROFILE: "personal" }),
    CHAT_TIMEOUT: "30s",
  }
  const tokenFile = httpTokenFile(app, every ? ALL_PROFILES : "personal", env)
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
      return background(childEnv, [lockFile, mode, ...(publicUrl ? [publicUrl] : [])], openSync(log, "a")).pid ?? 0
    },
    pause: () => sleep(20),
  }
  const cli = async (argv: string[]) => {
    const streams = captureStreams()
    const code = await run(
      [...(every ? [] : ["personal"]), ...argv, ...(every ? ["--profiles", "all"] : []), "--json"],
      { app, commands: () => [mcp(tokenFile, env)] },
      { streams, tty: false, env, system },
    )
    const out = streams.stdout.join("")
    return { code, item: out ? JSON.parse(out).item : undefined, error: streams.stderr.join("") }
  }
  return { env, tokenFile, lockFile, launched, cli }
}

const PUBLIC = ["--public-url", "https://laptop.example.ts.net"]

describe("mcp server", () => {
  it("starts mcp serve --http apart from the shell with the marker, and answers with the port, address and login code", async () => {
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
      "serve",
      "--http",
      "--port",
      "9001",
      "--public-url",
      "https://laptop.example.ts.net",
    ])
    expect(launched[0]?.env).toMatchObject({ CHAT_MCP_HTTP: "personal", CHAT_PROFILE: "personal" })
    expect(launched[0]?.env.CHAT_TIMEOUT).toBeUndefined()
  })

  it.runIf(process.platform === "linux")(
    "**upgrade restarts a server `start` launched, with its permission limits, on the new version**",
    async () => {
      const { cli, env, lockFile, launched } = setup()
      const started = await cli(["mcp", "server", "start", ...PUBLIC, "--permission", "messages.send=deny"])
      expect(started.code).toBe(0)
      expect(readHttpLaunch(httpLaunchFile(lockFile))).toEqual({
        invocation: "chat personal",
        argv: launched[0]?.argv,
        env: { CHAT_PROFILE: "personal", CHAT_MCP_HTTP: "personal" },
      })

      const [restarted] = await restartMcpServers(app, env, {
        platform: process.platform,
        alive,
        carries,
        stop: (pid) => process.kill(pid, "SIGTERM"),
        spawn: (argv, childEnv, log) => {
          launched.push({ argv, env: childEnv })
          return background({ ...childEnv, FAKE_VERSION: "2" }, [lockFile, "serve"], openSync(log, "a")).pid ?? 0
        },
        pause: () => sleep(20),
        processes: () => [],
        packageRoot: undefined,
      })

      expect(restarted).toMatchObject({ name: "chat personal", restarted: true, from: "1", to: "2" })
      expect(alive(started.item.pid)).toBe(false)
      expect(launched[1]?.argv).toEqual(launched[0]?.argv)
      expect(launched[1]?.argv).toContain("messages.send=deny")
      expect(launched[1]?.env).toMatchObject({ CHAT_MCP_HTTP: "personal", CHAT_PROFILE: "personal" })
    },
  )

  it("starts the server of every profile under the tool's path of a shared address", async () => {
    const { cli, launched } = setup("serve", { every: true, publicUrl: "https://laptop.example.ts.net/chat" })

    const { code, item, error } = await cli([
      "mcp",
      "server",
      "start",
      "--public-url",
      "https://laptop.example.ts.net/chat/",
    ])
    expect(error).toBe("")

    expect(code).toBe(0)
    expect(item).toMatchObject({
      profile: null,
      profiles: "all",
      started: true,
      connector_url: "https://laptop.example.ts.net/chat/mcp",
    })
    expect(launched[0]?.argv).toEqual([
      "mcp",
      "serve",
      "--http",
      "--profiles",
      "all",
      "--port",
      "8765",
      "--public-url",
      "https://laptop.example.ts.net/chat",
    ])
    expect(launched[0]?.env.CHAT_PROFILE).toBeUndefined()
    expect(launched[0]?.env.CHAT_MCP_HTTP).toBe(ALL_PROFILES)

    const status = await cli(["mcp", "server", "status"])
    expect(status.item).toMatchObject({ running: true, by: "server", profiles: "all" })
    const stopped = await cli(["mcp", "server", "stop"])
    expect(stopped.item).toMatchObject({ stopped: true })
  })

  it.each([
    [["mcp", "server", "start", ...PUBLIC], "name the profiles to serve"],
    [["work", "mcp", "serve", "--profiles", "personal"], "not both"],
    [["work", "mcp", "config", "--profiles", "all"], "not both"],
    [["mcp", "revoke"], "name the profiles to serve"],
  ])("refuses %j with exit 2 and lists the profiles", async (argv, words) => {
    const root = mkdtempSync(join(tmpdir(), "mcp-server-"))
    const env = { CHAT_CONFIG_DIR: join(root, "config"), CHAT_STATE_DIR: join(root, "state") }
    mkdirSync(env.CHAT_CONFIG_DIR, { recursive: true })
    writeFileSync(join(env.CHAT_CONFIG_DIR, "config.json"), JSON.stringify({ profiles: { work: {}, personal: {} } }))
    const streams = captureStreams()

    const code = await run(
      [...argv, "--json"],
      { app, commands: () => [mcpCommand(messenger)] },
      { streams, tty: false, env },
    )

    expect(code).toBe(2)
    const { error } = JSON.parse(streams.stderr.join(""))
    expect(error).toMatchObject({ code: "validation_error", details: { profiles: ["personal", "work"] } })
    expect(error.message).toContain(words)
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

    const refusal = JSON.parse(error.trim().split("\n").at(-1) ?? "null").error
    expect(code).not.toBe(0)
    expect(refusal.message).toMatch(/port 8765 is in use/)
    expect(refusal.retry?.safe).not.toBe(true)
  })

  it("hands --permission to the server", async () => {
    const { cli, launched } = setup()

    const { code } = await cli(["mcp", "server", "start", ...PUBLIC, "--permission", "messages.send=deny"])

    expect(code).toBe(0)
    expect(launched[0]?.argv.slice(-2)).toEqual(["--permission", "messages.send=deny"])
  })

  it("refuses --permission before starting anything when the CLI's server does not take it", async () => {
    const { cli, launched } = setup("serve", {
      mcp: (tokenFile, env) =>
        new Command("mcp").addCommand(
          mcpServerCommand({
            example: "chat personal",
            target: () => ({
              invocation: "chat personal",
              profile: "personal",
              envPrefix: "CHAT",
              env,
              tokenFile,
              argv: ["mcp", "serve", "--http"],
              version: "1",
            }),
            answer: () => {
              throw new CliError("validation_error", "must not answer")
            },
          }),
        ),
    })

    const { code, error } = await cli(["mcp", "server", "start", ...PUBLIC, "--permission", "messages.send=deny"])

    expect(code).toBe(2)
    expect(error).toMatch(/--permission/)
    expect(launched).toHaveLength(0)
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
