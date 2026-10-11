import { type Installer, isNewer, updateCommand } from "@wirecat/cli-base/update"

export interface ServerRestarts {
  restarted: readonly string[]
  left: readonly string[]
}

export interface PackageUpgradePorts {
  installer: () => Installer
  latest: () => Promise<string | undefined>
  install: (argv: string[]) => number | Promise<number>
  afterUpdate?: () => ServerRestarts | Promise<ServerRestarts>
  onInstall?: (argv: readonly string[]) => void
}

export interface PackageUpgradeResult {
  current: string
  latest: string | null
  newer: boolean
  installer: Installer
  command: string | null
  updated: boolean
  restarted: readonly string[]
}

export interface PackageUpgradeOutcome {
  result: PackageUpgradeResult
  reason: "checked" | "unavailable" | "up_to_date" | "manual" | "updated"
  left: readonly string[]
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
  if (code !== 0) throw new Error(`${argv[0]} exited with ${code}; ${command} is still ${current}`)
  const servers = await ports.afterUpdate?.()
  return {
    result: { ...result, updated: true, restarted: servers?.restarted ?? [] },
    reason: "updated",
    left: servers?.left ?? [],
  }
}
