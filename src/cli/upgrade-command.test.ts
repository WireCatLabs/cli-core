import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
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
) => {
  const app = { command, appName: "app-cli", envPrefix: "APP", version: "1.0.0", description: "Synthetic CLI" }
  const streams = captureStreams()
  const code = await run(
    argv,
    {
      app,
      commands: () => [upgradeCommand(app, `@synthetic/${command}`, (from) => ({ ...outputFor(from), ...ports }))],
    },
    { streams, tty, env },
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

  it("runs the script as a child process when no spawn is given", () => {
    const env = serving("personal", "work")
    const script = join(mkdtempSync(join(tmpdir(), "restart-script-")), "app.js")
    writeFileSync(script, "process.exit(process.argv[2] === 'work' ? 3 : 0)\n")
    expect(restartServers(app, script, env)).toEqual({ restarted: ["personal"], left: ["work"] })
  })
})
