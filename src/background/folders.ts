import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CliError, legacyMacPaths, migrateLegacyMacPaths, type Paths } from "@wirecat/cli-base"
import type { AppIdentity } from "../cli/app.js"
import { readLock } from "./lock.js"
import { alive } from "./processes.js"

export interface FolderOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  lsof?: (dirs: string[]) => string[]
  warn?: (line: string) => void
}

// lsof misses a serve between writes: its lock is written and closed again.
const liveServes = (dir: string): string[] => {
  const serve = join(dir, "serve")
  if (!existsSync(serve)) return []
  return readdirSync(serve)
    .filter((name) => name.endsWith(".lock"))
    .flatMap((name) => {
      const pid = readLock(join(serve, name))?.pid
      return pid !== undefined && alive(pid) ? [`pid ${pid} (serve, ${dir})`] : []
    })
}

/** An installed `serve` agent logs into the state folder; launchd does not create a folder that moved away. */
const repointAgents = (appName: string, from: string, to: string, env: NodeJS.ProcessEnv) => {
  const agents = join(env.HOME ?? "", "Library", "LaunchAgents")
  if (!existsSync(agents)) return
  for (const name of readdirSync(agents).filter((file) => file.startsWith(`${appName}.serve.`))) {
    const path = join(agents, name)
    const text = readFileSync(path, "utf8")
    if (text.includes(`${from}/`)) writeFileSync(path, text.replaceAll(`${from}/`, `${to}/`))
  }
}

/**
 * Moves the CLI's folders, the shared store's and the shared cache's out of `~/Library` on macOS, at
 * program start. A move that cannot happen now never stops the command: it warns, and this run keeps
 * using the old folders through the `*_DIR` overrides, so the new ones stay empty and the next run
 * tries again.
 */
export const migrateFolders = (
  app: Pick<AppIdentity, "command" | "appName" | "envPrefix">,
  options: FolderOptions = {},
) => {
  const { env = process.env, platform = process.platform, lsof } = options
  const warn = options.warn ?? ((line: string) => process.stderr.write(`${line}\n`))
  const owners = [
    [app.appName, app.envPrefix],
    ["cli-messaging", "MESSAGING"],
    ["cli-common", "CLI_COMMON"],
  ] as const
  for (const [appName, prefix] of owners) {
    try {
      const serving = platform === "darwin" ? liveServes(legacyMacPaths(appName, env).state) : []
      if (serving.length > 0)
        throw new CliError("configuration_error", `a serve is running (${serving.join(", ")}) — stop it and run again`)
      const moves = migrateLegacyMacPaths({ appName, prefix, env, platform, ...(lsof ? { holders: lsof } : {}) })
      const state = moves.find((move) => move.kind === "state")
      if (state) repointAgents(appName, state.from, state.to, env)
    } catch (error) {
      const legacy = legacyMacPaths(appName, env)
      for (const kind of ["config", "state", "cache"] as (keyof Paths)[])
        if (existsSync(legacy[kind])) env[`${prefix}_${kind.toUpperCase()}_DIR`] = legacy[kind]
      warn(`${app.command}: kept ${appName}'s files in ~/Library for now — ${(error as Error).message}`)
    }
  }
}
