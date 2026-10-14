import { captureStreams } from "@wirecat/cli-base"
import { describe, expect, it, vi } from "vitest"
import type { PackageUpgradePorts } from "../services/package-upgrade.js"
import { outputFor } from "./context.js"
import { run } from "./program.js"
import { upgradeCommand } from "./upgrade-command.js"

const call = async (command: string, argv: string[], ports: PackageUpgradePorts, tty = false) => {
  const app = { command, appName: "app-cli", envPrefix: "APP", version: "1.0.0", description: "Synthetic CLI" }
  const streams = captureStreams()
  const code = await run(
    argv,
    {
      app,
      commands: () => [upgradeCommand(app, `@synthetic/${command}`, (from) => ({ ...outputFor(from), ...ports }))],
    },
    { streams, tty, env: process.env },
  )
  return { code, stdout: streams.stdout, stderr: streams.stderr }
}
const itemOf = (line: string | undefined, format = "json") => {
  const parsed = JSON.parse(line ?? "")
  return format === "json" ? parsed.item : parsed
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

  it.each(["json", "jsonl"])("installs once and keeps progress off %s stdout", async (format) => {
    const ports = fake()
    ports.afterUpdate = async () => ({ restarted: ["synthetic"], left: ["manual"] })
    const result = await call(command, ["upgrade", `--${format}`], ports)
    expect(result.code).toBe(0)
    expect(result.stdout).toHaveLength(1)
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
      "(1 day by default, so after 2026-10-13T01:25:01.496Z) — `pnpm add -g @synthetic/tg@2.0.0` installs it now",
  )
})
