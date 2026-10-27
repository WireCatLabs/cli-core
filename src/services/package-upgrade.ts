import { CliError } from "@wirecat/cli-base"
import { type Installer, isNewer, updateCommand } from "@wirecat/cli-base/update"
import type { McpServerRestart, StaleSessions } from "../background/after-upgrade.js"

export interface ServerRestarts {
  restarted: readonly string[]
  left: readonly string[]
  /** Profiles whose `server restart` ran out of time: their serve may still run the old code. */
  timedOut?: readonly string[]
  mcpServers?: readonly McpServerRestart[]
  staleSessions?: StaleSessions
}

export interface PackageUpgradePorts {
  installer: () => Installer
  latest: () => Promise<string | undefined>
  install: (argv: string[]) => number | Promise<number>
  afterUpdate?: () => ServerRestarts | Promise<ServerRestarts>
  onInstall?: (argv: readonly string[]) => void
  /** The version the command now answers, read after the install; `undefined` when it cannot be read. */
  installed?: () => string | undefined | Promise<string | undefined>
  /** When npm published this version, ISO 8601; `undefined` when it cannot be read. */
  publishedAt?: (version: string) => Promise<string | undefined>
}

export interface PackageUpgradeResult {
  current: string
  latest: string | null
  newer: boolean
  installer: Installer
  command: string | null
  updated: boolean
  restarted: readonly string[]
  /** Set once an install ran: the HTTP MCP servers it restarted or left, and the stdio sessions still on old code. */
  mcpServers?: readonly McpServerRestart[]
  staleSessions?: StaleSessions
  installed?: string
  /** The package manager installed an older version than `latest`. */
  heldBack?: { until: string | null; command: string }
}

export interface PackageUpgradeOutcome {
  result: PackageUpgradeResult
  reason: "checked" | "unavailable" | "up_to_date" | "manual" | "updated" | "held_back"
  left: readonly string[]
  timedOut?: readonly string[]
}

export const upgradePackage = async (
  { current, command, packageName, check }: { current: string; command: string; packageName: string; check: boolean },
  ports: PackageUpgradePorts,
): Promise<PackageUpgradeOutcome> => {
  const installer = ports.installer()
  const argv = updateCommand(installer, packageName)
  const latest = await ports.latest()
  const newer = latest !== undefined && isNewer(latest, current)
  const result: PackageUpgradeResult = {
    current,
    latest: latest ?? null,
    newer,
    installer,
    command: argv?.join(" ") ?? null,
    updated: false,
    restarted: [],
  }
  if (check) return { result, reason: "checked", left: [] }
  if (latest === undefined) return { result, reason: "unavailable", left: [] }
  if (!newer) return { result, reason: "up_to_date", left: [] }
  if (!argv) return { result, reason: "manual", left: [] }
  ports.onInstall?.(argv)
  const code = await ports.install(argv)
  if (code !== 0)
    throw new CliError("provider_error", `${argv[0]} exited with ${code}; ${command} is still ${current}`, {
      reason: "upgrade.install-failed",
    })
  const installed = await ports.installed?.()
  if (installed === undefined) return restart(result, ports)
  const read = { ...result, installed }
  if (!isNewer(latest, installed)) return restart(read, ports)
  const heldBack = {
    // pnpm 11 resolves `@latest` to the newest version older than minimumReleaseAge, 1 day by default.
    until: installer === "pnpm" ? dayAfter(await ports.publishedAt?.(latest)) : null,
    // Only the package word changes: cli-base puts pnpm's minimumReleaseAge exemption after it.
    command: argv.map((word) => (word === `${packageName}@latest` ? `${packageName}@${latest}` : word)).join(" "),
  }
  if (installed === current) return { result: { ...read, heldBack }, reason: "held_back", left: [] }
  return { ...(await restart({ ...read, heldBack }, ports)), reason: "held_back" }
}

const restart = async (result: PackageUpgradeResult, ports: PackageUpgradePorts): Promise<PackageUpgradeOutcome> => {
  const servers = await ports.afterUpdate?.()
  return {
    result: {
      ...result,
      updated: true,
      restarted: servers?.restarted ?? [],
      ...(servers?.mcpServers ? { mcpServers: servers.mcpServers } : {}),
      ...(servers?.staleSessions ? { staleSessions: servers.staleSessions } : {}),
    },
    reason: "updated",
    left: servers?.left ?? [],
    ...(servers?.timedOut?.length ? { timedOut: servers.timedOut } : {}),
  }
}

const dayAfter = (published: string | undefined): string | null => {
  const time = published === undefined ? Number.NaN : Date.parse(published)
  return Number.isNaN(time) ? null : new Date(time + 24 * 60 * 60 * 1000).toISOString()
}
