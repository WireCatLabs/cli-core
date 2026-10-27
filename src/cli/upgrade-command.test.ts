import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
import type { AfterUpgradeSystem } from "../background/after-upgrade.js"
import { holdLock, lockPath } from "../background/lock.js"
import type { PackageUpgradePorts } from "../services/package-upgrade.js"
import { outputFor } from "./context.js"
import { run } from "./program.js"
import { restartServers, upgradeCommand } from "./upgrade-command.js"

const call = async (
  command: string,
  argv: string[],
  ports: PackageUpgradePorts,
  tty = false,
  env: NodeJS.ProcessEnv = process.env,
  afterUpgrade?: Partial<AfterUpgradeSystem>,
) => {
  const app = { command, appName: "app-cli", envPrefix: "APP", version: "1.0.0", description: "Synthetic CLI" }
  const streams = captureStreams()
  const code = await run(
    argv,
    {
      app,
      commands: () => [upgradeCommand(app, `@synthetic/${command}`, (from) => ({ ...outputFor(from), ...ports }))],
    },
    { streams, tty, env, ...(afterUpgrade ? { afterUpgrade } : {}) } as never,
  )
  return { code, stdout: streams.stdout, stderr: streams.stderr }
}
const itemOf = (line: string | undefined, format = "json") => {
  const parsed = JSON.parse(line ?? "")
  return format === "json" ? parsed.item : parsed.data
}
const fake = (): PackageUpgradePorts => ({
  installer: () => "npm",
  latest: async () => "2.0.0",
  install: vi.fn(() => 0),
})

describe.each(["max", "tg"])("the shared upgrade command for %s", (command) => {
  it("checks without installing or restarting and exposes one common result shape", async () => {
    const ports = fake()
    ports.afterUpdate = vi.fn(() => ({ restarted: [], left: [] }))
    const result = await call(command, ["upgrade", "--check", "--json"], ports)
    expect(result.code).toBe(0)
    expect(result.stdout).toHaveLength(1)
    expect(itemOf(result.stdout[0])).toEqual({
      current: "1.0.0",
      latest: "2.0.0",
      newer: true,
      installer: "npm",
      command: `npm install -g @synthetic/${command}@latest`,
      updated: false,
      restarted: [],
    })
    expect(result.stderr).toEqual([])
    expect(ports.install).not.toHaveBeenCalled()
    expect(ports.afterUpdate).not.toHaveBeenCalled()
  })

  it("**checks under the read-only lock, and refuses the install there**", async () => {
    const env = { ...process.env, APP_READ_ONLY: "1" }
    const ports = fake()
    ports.latest = vi.fn(async () => "2.0.0")

    const checked = await call(command, ["upgrade", "--check", "--json"], ports, false, env)
    expect(checked.code).toBe(0)
    expect(itemOf(checked.stdout[0])).toMatchObject({ latest: "2.0.0", newer: true, updated: false })

    const refused = await call(command, ["upgrade", "--json", "--no-record"], ports, false, env)
    expect(refused.code).toBe(5)
    expect(JSON.parse(refused.stderr.at(-1) ?? "").error.message).toBe(
      `this process is read-only (APP_READ_ONLY) — \`${command} upgrade\` changes what a later run may do; ` +
        "run it without APP_READ_ONLY",
    )
    expect(ports.latest).toHaveBeenCalledOnce()
    expect(ports.install).not.toHaveBeenCalled()
  })

  it("**never asks npm with --offline, --check included**", async () => {
    const ports = fake()
    ports.latest = vi.fn(async () => "2.0.0")
    for (const argv of [["upgrade", "--check"], ["upgrade"]]) {
      const result = await call(command, [...argv, "--offline", "--json", "--no-record"], ports)
      expect(result.code).toBe(2)
      expect(JSON.parse(result.stderr.at(-1) ?? "").error.message).toContain("not with --offline")
    }
    expect(ports.latest).not.toHaveBeenCalled()
    expect(ports.install).not.toHaveBeenCalled()
  })

  it.each(["json", "jsonl"])("installs once and keeps progress off %s stdout", async (format) => {
    const ports = fake()
    ports.afterUpdate = async () => ({ restarted: ["synthetic"], left: ["manual"] })
    const result = await call(command, ["upgrade", `--${format}`], ports)
    expect(result.code).toBe(0)
    expect(result.stdout).toHaveLength(format === "json" ? 1 : 2)
    expect(itemOf(result.stdout[0], format)).toMatchObject({ updated: true, restarted: ["synthetic"] })
    expect(result.stderr.join("\n")).toContain("running: npm install")
    expect(result.stderr.join("\n")).toContain(`${command} manual server restart`)
    expect(ports.install).toHaveBeenCalledOnce()
  })

  it.each(["checkout", "npx", "unknown"] as const)("names the manual path for %s", async (installer) => {
    const ports = fake()
    ports.installer = () => installer
    const result = await call(command, ["upgrade", "--json"], ports)
    expect(result.code).toBe(0)
    expect(itemOf(result.stdout[0])).toMatchObject({ updated: false, command: null, restarted: [] })
    expect(result.stderr.length).toBeGreaterThan(0)
    expect(ports.install).not.toHaveBeenCalled()
  })

  it("reports an installer failure once and prints no success result", async () => {
    const ports = fake()
    ports.install = vi.fn(() => 7)
    const result = await call(command, ["upgrade", "--json", "--no-record"], ports)
    expect(result.code).toBe(11)
    expect(result.stdout).toEqual([])
    expect(JSON.parse(result.stderr.at(-1) ?? "").error.message).toContain(`${command} is still 1.0.0`)
    expect(ports.install).toHaveBeenCalledOnce()
  })

  it.each([undefined, "1.0.0"])("describes an unavailable or unchanged version in both views", async (latest) => {
    const ports = fake()
    ports.latest = async () => latest
    for (const tty of [false, true]) {
      const result = await call(command, ["upgrade"], ports, tty)
      expect(result.code).toBe(0)
      expect(result.stdout).toHaveLength(1)
      expect(result.stdout.join("\n")).toContain("1.0.0")
    }
    expect(ports.install).not.toHaveBeenCalled()
  })

  it("keeps the pretty success and host restart summary", async () => {
    const ports = fake()
    ports.afterUpdate = () => ({ restarted: ["synthetic"], left: [] })
    const result = await call(command, ["upgrade"], ports, true)
    expect(result.stdout.join("\n")).toContain(`${command} 1.0.0 → 2.0.0`)
    expect(result.stdout.join("\n")).toContain("profile synthetic")
  })
})

it("keeps a plain pretty update summary without a host restart port", async () => {
  const result = await call("max", ["upgrade"], fake(), true)
  expect(result.code).toBe(0)
  expect(result.stdout.join("\n")).toContain("max 1.0.0 → 2.0.0")
  expect(result.stdout.join("\n")).not.toContain("restarted")
})

it("**says plainly when the package manager installed an older version than latest**", async () => {
  const ports = fake()
  ports.installer = () => "pnpm"
  ports.installed = () => "1.5.0"
  ports.publishedAt = async () => "2026-10-12T01:25:01.496Z"
  const result = await call("tg", ["upgrade"], ports, true)
  expect(result.code).toBe(0)
  expect(result.stdout.join("\n")).toContain("tg 1.0.0 → 1.5.0; 2.0.0 is held back")
  expect(result.stderr.join("\n")).toContain(
    "installed 1.5.0, not 2.0.0: pnpm installs a version only once it is older than its minimum release age " +
      "(1 day by default, so after 2026-10-13T01:25:01.496Z) — `pnpm add -g @synthetic/tg@2.0.0 --config.minimumReleaseAgeExclude=@synthetic/*` installs it now",
  )
})

describe("after the install", () => {
  const sessions = (lines: ReturnType<AfterUpgradeSystem["processes"]>) => {
    const root = mkdtempSync(join(tmpdir(), "upgrade-pkg-"))
    return {
      processes: vi.fn(() => lines),
      packageRoot: root,
      line: (pid: number, ...words: string[]) => ({ pid, words: ["node", join(root, "dist/app.js"), ...words] }),
    }
  }

  it("**names the stdio MCP sessions still on the old version, in both views, and leaves them running**", async () => {
    const root = mkdtempSync(join(tmpdir(), "upgrade-pkg-"))
    const line = (pid: number, ...words: string[]) => ({ pid, words: ["node", join(root, "dist/app.js"), ...words] })
    const fakeSystem = {
      packageRoot: root,
      processes: () => [line(501, "personal", "mcp"), line(502, "mcp"), line(503, "personal", "mcp", "--http")],
      stop: vi.fn(),
    }
    const json = await call("tg", ["upgrade", "--json"], fake(), false, process.env, fakeSystem)
    expect(json.code).toBe(0)
    expect(itemOf(json.stdout[0])).toMatchObject({
      updated: true,
      mcp_servers: [],
      stale_sessions: {
        checked: true,
        sessions: [
          { pid: 501, version: null },
          { pid: 502, version: null },
        ],
      },
    })
    expect(json.stderr.join("\n")).toContain(
      "2 MCP sessions over stdio still run tg 1.0.0 or older (PID 501, 502) — " +
        "restart them from your agent app (start a new chat, or reload its MCP servers)",
    )
    expect(fakeSystem.stop).not.toHaveBeenCalled()

    const pretty = await call("tg", ["upgrade"], fake(), true, process.env, fakeSystem)
    expect(pretty.stdout.join("\n")).toContain("tg 1.0.0 → 2.0.0")
    expect(pretty.stderr.join("\n")).toContain("(PID 501, 502)")
  })

  it("says it could not check stdio sessions instead of claiming there are none", async () => {
    const result = await call("tg", ["upgrade", "--json"], fake(), false, process.env, {
      processes: () => undefined,
      packageRoot: "/x",
    })
    expect(itemOf(result.stdout[0]).stale_sessions).toMatchObject({ checked: false, sessions: [] })
    expect(result.stderr.join("\n")).toContain("could not check for MCP sessions over stdio")
  })

  it("restarts and checks nothing when nothing was installed or the install failed", async () => {
    for (const ports of [
      { ...fake(), latest: async () => "1.0.0" },
      { ...fake(), install: vi.fn(() => 7) },
    ]) {
      const { processes, packageRoot } = sessions([])
      const result = await call("tg", ["upgrade", "--json", "--no-record"], ports, false, process.env, {
        processes,
        packageRoot,
      })
      expect(result.stdout.join("")).not.toContain("stale_sessions")
      expect(processes).not.toHaveBeenCalled()
    }
  })

  it("reports the HTTP MCP server it restarted, old → new version, and one it left", async () => {
    const env = { ...process.env, APP_STATE_DIR: mkdtempSync(join(tmpdir(), "upgrade-http-")) }
    const lockFile = join(env.APP_STATE_DIR, "mcp-http", "personal.lock")
    const lock = { startedAt: "2026-10-27T10:00:00.000Z", listeningAt: "2026-10-27T10:00:00.000Z", port: 8765 }
    const publicUrl = "https://laptop.example.ts.net/"
    holdLock(lockFile, { ...lock, pid: 71, version: "1.0.0", publicUrl } as never)
    writeFileSync(
      join(env.APP_STATE_DIR, "mcp-http", "personal.launch.json"),
      JSON.stringify({ invocation: "tg personal", argv: ["mcp", "--http"], env: { APP_MCP_HTTP: "personal" } }),
    )
    holdLock(join(env.APP_STATE_DIR, "mcp-http", "_all.lock"), {
      ...lock,
      pid: 72,
      version: "1.0.0",
      publicUrl,
    } as never)
    const running = new Set([71, 72])
    const system: Partial<AfterUpgradeSystem> = {
      alive: (pid) => running.has(pid),
      carries: (pid) => pid === 71,
      stop: (pid) => running.delete(pid),
      spawn: () => {
        running.add(81)
        holdLock(lockFile, { ...lock, pid: 81, version: "2.0.0", publicUrl } as never)
        return 81
      },
      pause: async () => {},
      processes: () => [],
      packageRoot: "/x",
    }
    const json = await call("tg", ["upgrade", "--json"], fake(), false, env, system)
    const servers = itemOf(json.stdout[0]).mcp_servers
    expect(servers).toContainEqual({
      name: "tg personal",
      pid: 71,
      restarted: true,
      from: "1.0.0",
      to: "2.0.0",
      new_pid: 81,
    })
    expect(servers).toContainEqual(expect.objectContaining({ pid: 72, restarted: false }))
    expect(json.stderr.join("\n")).toContain("(PID 72) was not restarted")
    expect(running.has(72)).toBe(true)

    running.add(71).delete(81)
    holdLock(lockFile, { ...lock, pid: 71, version: "1.0.0", publicUrl } as never)
    const pretty = await call("tg", ["upgrade"], fake(), true, env, system)
    expect(pretty.stdout.join("\n")).toContain("restarted the HTTP MCP server tg personal (1.0.0 → 2.0.0)")
  })

  it("says plainly when serve's restart ran out of time", async () => {
    const ports = fake()
    ports.afterUpdate = () => ({ restarted: [], left: ["personal"], timedOut: ["personal"] })
    const result = await call("tg", ["upgrade"], ports, true, process.env, { processes: () => [], packageRoot: "/x" })
    expect(result.stderr.join("\n")).toContain(
      "the server for profile personal did not restart in time and may still run tg 1.0.0 — `tg personal server status`",
    )
  })
})

describe("restartServers", () => {
  const app = { command: "app", appName: "app-cli", envPrefix: "APP", version: "1.0.0", description: "Synthetic CLI" }
  const serving = (...profiles: string[]) => {
    const env = { ...process.env, APP_STATE_DIR: mkdtempSync(join(tmpdir(), "restart-")) }
    for (const profile of profiles)
      holdLock(lockPath(app, profile, env), { pid: process.pid, startedAt: new Date().toISOString() })
    return env
  }

  it("restarts each serving profile with the new script and names the ones that refuse", () => {
    const env = serving("personal", "work")
    const spawn = vi.fn((argv: string[]) => (argv[2] === "work" ? 1 : 0))
    expect(restartServers(app, "/x/bin/app.js", env, spawn)).toEqual({ restarted: ["personal"], left: ["work"] })
    expect(spawn).toHaveBeenCalledWith([process.execPath, "/x/bin/app.js", "personal", "server", "restart"])
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it("skips a lock named like no profile and does nothing when nothing serves", () => {
    const spawn = vi.fn(() => 0)
    expect(restartServers(app, "/x/bin/app.js", serving(".hidden bad"), spawn)).toEqual({ restarted: [], left: [] })
    expect(restartServers(app, "/x/bin/app.js", serving(), spawn)).toEqual({ restarted: [], left: [] })
    expect(spawn).not.toHaveBeenCalled()
  })

  it("names a profile whose restart ran out of time", () => {
    const env = serving("personal")
    expect(restartServers(app, "/x/bin/app.js", env, () => 9)).toEqual({
      restarted: [],
      left: ["personal"],
      timedOut: ["personal"],
    })
  })

  it("runs the script as a child process when no spawn is given", () => {
    const env = serving("personal", "work")
    const script = join(mkdtempSync(join(tmpdir(), "restart-script-")), "app.js")
    writeFileSync(script, "process.exit(process.argv[2] === 'work' ? 3 : 0)\n")
    expect(restartServers(app, script, env)).toEqual({ restarted: ["personal"], left: ["work"] })
  })
})
