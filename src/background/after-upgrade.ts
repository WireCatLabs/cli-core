import { execFileSync, spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, sep } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { resolvePaths } from "@wirecat/cli-base"
import { type HttpLock, httpLaunchFile, mcpHttpMarker, readHttpLaunch, readHttpLock } from "../mcp/http/state.js"
import type { AppIdentity } from "../ports/app.js"
import { alive, carries } from "./processes.js"
import { readableLog, tail } from "./units.js"

/** One running HTTP MCP server, and what `upgrade` did with it. */
export interface McpServerRestart {
  /** What a person types before `mcp`, `tg personal`; the lock's path when nothing recorded it. */
  name: string
  pid: number
  restarted: boolean
  /** The version in its lock before, and in the new one's lock after; `null` when a lock does not say. */
  from: string | null
  to: string | null
  newPid?: number
  /** Why it was left as it was, or why it is not serving now. */
  reason?: string
}

/** The `mcp` sessions over stdin and stdout that an agent app started: only the app can restart them. */
export interface StaleSessions {
  checked: boolean
  /** `version` is `null`: a process does not say which code it loaded. */
  sessions: { pid: number; version: string | null }[]
  reason?: string
}

export interface ProcessLine {
  pid: number
  /** The command line, word by word; the first is the program. */
  words: string[]
}

/** What the steps after an upgrade ask of the machine. Tests hand one in. */
export interface AfterUpgradeSystem {
  platform: NodeJS.Platform
  alive: (pid: number) => boolean
  carries: (pid: number, marker: string) => boolean
  stop: (pid: number) => void
  /** Starts `<cli> <argv>` from the installed package, apart from this process, and answers its PID. */
  spawn: (argv: string[], env: NodeJS.ProcessEnv, log: string) => number
  pause: () => Promise<void>
  /** This user's processes; `undefined` when this system cannot list them. */
  processes: () => ProcessLine[] | undefined
  /** The folder of the package this process runs from; `undefined` when it does not run from one. */
  packageRoot: string | undefined
}

// 250 ms apart: 15 s for the old server to stop, 30 s for the new one to listen, as `mcp server start` waits.
const STOP_LOOKS = 60
const START_LOOKS = 120
const LOCK_DEPTH = 3

/** The nearest package around `script`, when it is `packageName`: a test runner's script belongs to the runner. */
export const packageRootOf = (packageName: string, script: string): string | undefined => {
  let dir = dirname(script)
  for (let up = 0; up < 8; up++) {
    const manifest = join(dir, "package.json")
    if (existsSync(manifest)) {
      try {
        return JSON.parse(readFileSync(manifest, "utf8")).name === packageName ? dir : undefined
      } catch {
        return undefined
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/**
 * The bin the new `package.json` names, read after the install: the new version may have moved its entry, and the
 * old process's own path may no longer exist.
 */
const binOf = (root: string, command: string): string | undefined => {
  try {
    const { bin } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      bin?: string | Record<string, string>
    }
    const path = typeof bin === "string" ? bin : bin?.[command]
    return path && existsSync(join(root, path)) ? join(root, path) : undefined
  } catch {
    return undefined
  }
}

const words = (line: string) => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? "")

const listProcesses = (platform: NodeJS.Platform): ProcessLine[] | undefined => {
  const uid = process.getuid?.()
  try {
    if (platform === "linux") {
      return readdirSync("/proc").flatMap((entry) => {
        if (!/^\d+$/.test(entry)) return []
        try {
          if (statSync(`/proc/${entry}`).uid !== uid) return []
          const line = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0")
          if (line.at(-1) === "") line.pop()
          return [{ pid: Number(entry), words: line }]
        } catch {
          return []
        }
      })
    }
    if (platform === "darwin") {
      const listed = execFileSync("ps", ["-axww", "-o", "pid=,uid=,command="], { encoding: "utf8", timeout: 5000 })
      return listed.split("\n").flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
        return match && Number(match[2]) === uid ? [{ pid: Number(match[1]), words: words(match[3] ?? "") }] : []
      })
    }
    if (platform === "win32") {
      // Without elevation Windows shows the command line of this user's processes only.
      const listed = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='bun.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
        ],
        { encoding: "utf8", timeout: 10_000, windowsHide: true },
      ).trim()
      if (listed === "") return []
      const parsed = JSON.parse(listed) as
        | { ProcessId: number; CommandLine: string | null }
        | { ProcessId: number; CommandLine: string | null }[]
      return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((one) =>
        one.CommandLine ? [{ pid: one.ProcessId, words: words(one.CommandLine) }] : [],
      )
    }
  } catch {
    return undefined
  }
  return undefined
}

export const thisSystem = (packageName: string, command: string): AfterUpgradeSystem => {
  const script = process.argv[1]
  let real: string | undefined
  try {
    real = script ? realpathSync(script) : undefined
  } catch {}
  const packageRoot = real ? packageRootOf(packageName, real) : undefined
  return {
    platform: process.platform,
    alive,
    carries,
    stop: (pid) => process.kill(pid, "SIGTERM"),
    spawn: (argv, env, log) => {
      const entry = (packageRoot && binOf(packageRoot, command)) ?? real ?? ""
      mkdirSync(dirname(log), { recursive: true, mode: 0o700 })
      const out = openSync(log, "a", 0o600)
      try {
        const child = spawn(process.execPath, [entry, ...argv], { detached: true, stdio: ["ignore", out, out], env })
        child.unref()
        return child.pid ?? 0
      } finally {
        closeSync(out)
      }
    },
    pause: () => sleep(250),
    processes: () => listProcesses(process.platform),
    packageRoot,
  }
}

/** Every HTTP lock under the state folder: each CLI lays them out its own way, a few folders deep at most. */
const httpLocks = (dir: string, depth = 0): string[] => {
  let entries: import("node:fs").Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return depth < LOCK_DEPTH ? httpLocks(path, depth + 1) : []
    return entry.isFile() && entry.name.endsWith(".lock") && readHttpLock(path) ? [path] : []
  })
}

const errorText = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "EPERM"
    ? "not allowed to stop it"
    : error instanceof Error
      ? error.message
      : String(error)

const restartOne = async (
  envPrefix: string,
  lockFile: string,
  lock: HttpLock,
  env: NodeJS.ProcessEnv,
  system: AfterUpgradeSystem,
): Promise<McpServerRestart> => {
  const launch = readHttpLaunch(httpLaunchFile(lockFile))
  const name = launch?.invocation ?? lockFile
  const from = lock.version ?? null
  const left = (reason: string, rest: Partial<McpServerRestart> = {}): McpServerRestart => ({
    name,
    pid: lock.pid,
    restarted: false,
    from,
    to: null,
    reason,
    ...rest,
  })
  const marker = mcpHttpMarker(envPrefix)
  const value = launch?.env[marker]
  // The marker proves the PID is still the server `mcp server start` launched, not a stranger who got its number.
  if (!launch || value === undefined || !system.carries(lock.pid, `${marker}=${value}`))
    return left(
      "it was not started by `mcp server start` on this version, or this system cannot confirm it was — stop it and start it again",
    )
  try {
    system.stop(lock.pid)
  } catch (error) {
    return left(errorText(error))
  }
  for (let look = 0; look < STOP_LOOKS && system.alive(lock.pid); look++) await system.pause()
  if (system.alive(lock.pid))
    return left(`asked it to stop, and it still ran after 15 s — \`${name} mcp server status\``)

  const log = lockFile.replace(/\.lock$/, ".log")
  const { [`${envPrefix}_TIMEOUT`]: _timeout, ...inherited } = env
  let pid: number
  try {
    pid = system.spawn(launch.argv, { ...inherited, ...launch.env }, log)
  } catch (error) {
    return left(`stopped it, and could not start it again: ${errorText(error)} — \`${name} mcp server start\``)
  }
  for (let look = 0; look < START_LOOKS; look++) {
    const now = readHttpLock(lockFile)
    if (now?.pid === pid && now.listeningAt)
      return { name, pid: lock.pid, restarted: true, from, to: now.version ?? null, newPid: pid }
    if (!system.alive(pid)) {
      const last = readableLog(tail(log, 5)).trim()
      return left(
        `stopped it, and the new one exited before it listened${last ? `: ${last}` : ""} — \`${name} mcp server start\``,
        { newPid: pid },
      )
    }
    await system.pause()
  }
  return left(`started it again (PID ${pid}), and it was not listening after 30 s — \`${name} mcp server status\``, {
    newPid: pid,
  })
}

/** Restarts each running HTTP MCP server of `app` on the code just installed, as `server restart` does for serve. */
export const restartMcpServers = async (
  app: AppIdentity,
  env: NodeJS.ProcessEnv,
  system: AfterUpgradeSystem,
): Promise<McpServerRestart[]> => {
  const state = resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state
  const done: McpServerRestart[] = []
  for (const lockFile of httpLocks(state)) {
    const lock = readHttpLock(lockFile)
    if (lock && system.alive(lock.pid)) done.push(await restartOne(app.envPrefix, lockFile, lock, env, system))
  }
  return done
}

// The `mcp` subcommands that are not a server; `mcp` alone was the server before `mcp serve`.
const NOT_SERVING = new Set(["server", "config", "add", "check", "revoke"])

/** Whether a command line runs an MCP server over stdio from the package in `root`: not `--http`, not `mcp server …`. */
export const isStdioMcp = (line: string[], root: string, platform: NodeJS.Platform = process.platform): boolean => {
  const at = line.findIndex((word, index) => index > 0 && !word.startsWith("-"))
  const script = line[at]
  if (at < 0 || script === undefined || !isAbsolute(script)) return false
  let path = script
  try {
    path = realpathSync(script)
  } catch {}
  const fold = (text: string) => (platform === "win32" ? text.toLowerCase() : text)
  if (!fold(path).startsWith(fold(root + sep)) && !fold(script).startsWith(fold(root + sep))) return false
  const rest = line.slice(at + 1)
  if (rest.includes("--http")) return false
  const plain = rest.filter((word) => !word.startsWith("-"))
  const mcp = plain.indexOf("mcp")
  const leads = plain.slice(0, Math.max(mcp, 0)).filter((word) => word !== "bot")
  return mcp >= 0 && leads.length <= 1 && !NOT_SERVING.has(plain[mcp + 1] ?? "")
}

export const staleMcpSessions = (system: AfterUpgradeSystem): StaleSessions => {
  const root = system.packageRoot
  if (root === undefined)
    return { checked: false, sessions: [], reason: "this process does not run from an installed package" }
  const lines = system.processes()
  if (lines === undefined)
    return { checked: false, sessions: [], reason: `could not list the processes on ${system.platform}` }
  return {
    checked: true,
    sessions: lines
      .filter((line) => line.pid !== process.pid && isStdioMcp(line.words, root, system.platform))
      .map((line) => ({ pid: line.pid, version: null })),
  }
}
