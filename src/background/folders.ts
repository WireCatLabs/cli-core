import { execFileSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { CliError, legacyMacPaths, migrateLegacyMacPaths, type Paths, resolvePaths } from "@wirecat/cli-base"
import type { AppIdentity } from "../cli/app.js"
import { wirecatDirectory } from "../store/path.js"
import { readLock } from "./lock.js"
import { alive } from "./processes.js"

export interface FolderOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  lsof?: (dirs: string[]) => string[]
  holders?: (oldState: string) => string[]
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

const treeSize = (path: string): number =>
  statSync(path).isDirectory()
    ? readdirSync(path).reduce((sum, name) => sum + treeSize(join(path, name)), 0)
    : statSync(path).size

/** A copy is removed from the old place only after it measures the same: the store is the owner's only copy. */
const moveEntry = (from: string, to: string) => {
  mkdirSync(dirname(to), { recursive: true })
  try {
    renameSync(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error
    cpSync(from, to, { recursive: true, errorOnExist: true })
    if (treeSize(from) !== treeSize(to)) {
      rmSync(to, { recursive: true, force: true })
      throw new CliError("configuration_error", `copying ${from} to ${to} came out a different size`)
    }
    rmSync(from, { recursive: true, force: true })
  }
}

const STORE = "wirecat.db"
const storeFiles = (directory: string): string[] =>
  readdirSync(directory).filter(
    (name) =>
      name === STORE ||
      [`${STORE}-wal`, `${STORE}-shm`].includes(name) ||
      name.startsWith(`${STORE}.backup-`) ||
      name.startsWith(`${STORE}.before-restore-`),
  )

/** A db without its wal loses writes, so a failure part-way puts back what already moved. */
const moveAll = (names: string[], from: string, to: string, move: (from: string, to: string) => void) => {
  const done: string[] = []
  try {
    for (const name of names) {
      move(join(from, name), join(to, name))
      done.push(name)
    }
  } catch (error) {
    const stuck: string[] = []
    for (const name of done.reverse()) {
      try {
        move(join(to, name), join(from, name))
      } catch {
        stuck.push(join(to, name))
      }
    }
    if (stuck.length > 0)
      throw new CliError(
        "configuration_error",
        `${(error as Error).message}; and could not put back ${stuck.join(", ")} — they are in ${to}, the rest is in ${from}`,
      )
    throw error
  }
}

const pidsOf = (listed: string): string[] =>
  listed
    .split("\n")
    .filter((pid) => pid && pid !== String(process.pid))
    .map((pid) => `pid ${pid}`)

/** Processes with a store file open: another tool's serve, mcp or job is not in any lock this one checks. */
const storeHolders = (oldState: string, platform: NodeJS.Platform): string[] => {
  if (platform === "darwin") {
    try {
      const out = execFileSync("/usr/sbin/lsof", ["-t", "+D", oldState], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      return pidsOf(out)
    } catch (error) {
      // lsof exits 1 when nothing is open; any other failure means it could not look, so nothing moves.
      const failure = error as { status?: number; stdout?: string }
      return failure.status === 1 ? pidsOf(failure.stdout ?? "") : ["lsof could not check"]
    }
  }
  if (platform !== "linux") return []
  const holders: string[] = []
  let pids: string[] = []
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid)
  } catch {
    return ["/proc could not be read"]
  }
  for (const pid of pids) {
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        let target: string
        try {
          target = readlinkSync(`/proc/${pid}/fd/${fd}`)
        } catch {
          continue
        }
        if (target.startsWith(join(oldState, STORE))) {
          holders.push(`pid ${pid} (${target})`)
          break
        }
      }
    } catch {}
  }
  return holders
}

/**
 * Brings the store and the models, which lived in `cli-messaging`'s and `cli-common`'s folders, into the
 * WireCat folder. Never when an override says where they are, never over a store that is already there,
 * and never while a serve has the old one open: that run keeps using the old file.
 */
export const migrateToWirecatFolder = (
  app: Pick<AppIdentity, "command" | "appName" | "envPrefix">,
  options: Pick<FolderOptions, "env" | "warn" | "platform"> & {
    holders?: (oldState: string) => string[]
    move?: (from: string, to: string) => void
  } = {},
) => {
  const { env = process.env, platform = process.platform, move = moveEntry } = options
  const holdersOf = options.holders ?? ((dir: string) => storeHolders(dir, platform))
  const warn = options.warn ?? ((line: string) => process.stderr.write(`${line}\n`))
  if (env.MESSAGING_STORE || env.WIRECAT_STATE_DIR) return
  const target = wirecatDirectory(env)
  const oldState = resolvePaths({ appName: "cli-messaging", prefix: "MESSAGING", env }).state
  const oldModels = join(resolvePaths({ appName: "cli-common", prefix: "CLI_COMMON", env }).cache, "models")
  try {
    if (existsSync(join(oldState, STORE))) {
      const serving = [
        ...[oldState, resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state].flatMap(liveServes),
        ...holdersOf(oldState),
      ]
      if (existsSync(join(target, STORE))) {
        warn(
          `${app.command}: two stores, ${join(oldState, STORE)} and ${join(target, STORE)} — using the second, merge by hand`,
        )
      } else if (serving.length > 0) {
        env.MESSAGING_STORE = join(oldState, STORE)
        warn(
          `${app.command}: something has the store open (${serving.join(", ")}) — the store moves to ${target} on a run after it stops`,
        )
      } else {
        moveAll(storeFiles(oldState), oldState, target, move)
      }
    }
    if (existsSync(oldModels) && !existsSync(join(target, "models"))) moveEntry(oldModels, join(target, "models"))
  } catch (error) {
    warn(`${app.command}: could not move the store or models to ${target} — ${(error as Error).message}`)
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
  const holders = options.holders ?? (lsof ? (dir: string) => lsof([dir]) : undefined)
  migrateToWirecatFolder(app, { env, platform, warn, ...(holders ? { holders } : {}) })
}
