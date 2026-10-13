import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs"
import { dirname, join, relative } from "node:path"
import { CliError, resolvePaths } from "@wirecat/cli-base"
import type { AppIdentity } from "../cli/app.js"
import { wirecatDirectory } from "../store/path.js"
import { readLock, releaseLock, takeLock } from "./lock.js"
import { alive } from "./processes.js"

// lsof misses a serve between writes: its lock is written and closed again.
export const liveServes = (dir: string): string[] => {
  const serve = join(dir, "serve")
  if (!existsSync(serve)) return []
  return readdirSync(serve)
    .filter((name) => name.endsWith(".lock"))
    .flatMap((name) => {
      const pid = readLock(join(serve, name))?.pid
      return pid !== undefined && alive(pid) ? [`pid ${pid} (serve, ${dir})`] : []
    })
}

/** Errors that leave the owner's store in a state no command should run on: they stop the command. */
class Stop extends CliError {
  constructor(message: string) {
    super("configuration_error", message)
  }
}

const conflict = (pairs: [string, string][]) =>
  new Stop(
    `two different copies of the store: ${pairs.map(([from, to]) => `${from} and ${to}`).join("; ")} — ` +
      "nothing was moved or changed; keep one of each pair and run again",
  )

const STORE = "wirecat.db"
const PARTIAL = ".partial-"
const SIDECARS = [`${STORE}-wal`, `${STORE}-shm`]

const isStoreFile = (name: string) =>
  !name.includes(PARTIAL) &&
  (name === STORE ||
    SIDECARS.includes(name) ||
    name.startsWith(`${STORE}.backup-`) ||
    name.startsWith(`${STORE}.before-restore-`))

// The db goes last: while it is still in the old folder the move is unfinished, and the next start resumes it.
const dbLast = (names: string[]) => [...names].sort((a, b) => Number(a === STORE) - Number(b === STORE))

const storeFiles = (directory: string): string[] =>
  existsSync(directory) ? dbLast(readdirSync(directory).filter(isStoreFile)) : []

const digest = (path: string): string => {
  const hash = createHash("sha256")
  const fd = openSync(path, "r")
  const buffer = Buffer.allocUnsafe(1 << 20)
  try {
    for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer)) hash.update(buffer.subarray(0, read))
  } finally {
    closeSync(fd)
  }
  return hash.digest("hex")
}

const sameFile = (a: string, b: string): boolean => {
  const [x, y] = [statSync(a, { bigint: true }), statSync(b, { bigint: true })]
  if (x.dev === y.dev && x.ino === y.ino) return true
  return x.size === y.size && digest(a) === digest(b)
}

const filesUnder = (root: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort()

const sameTree = (a: string, b: string): boolean => {
  const [left, right] = [filesUnder(a), filesUnder(b)]
  return left.join("\n") === right.join("\n") && left.every((file) => sameFile(join(a, file), join(b, file)))
}

const flush = (path: string, mode = "r+") => {
  const fd = openSync(path, mode)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

// Windows cannot open a folder to flush it; NTFS orders the rename on its own.
const flushFolder = (path: string) => {
  try {
    flush(path, "r")
  } catch {}
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException).code

const copyAcross = (from: string, to: string) => {
  const partial = `${to}${PARTIAL}${process.pid}`
  copyFileSync(from, partial, constants.COPYFILE_EXCL)
  try {
    flush(partial)
    if (!sameFile(from, partial)) throw new Error(`the copy of ${from} at ${partial} came out different`)
    linkSync(partial, to)
  } catch (error) {
    if (errno(error) === "EEXIST") throw conflict([[from, to]])
    throw error
  } finally {
    rmSync(partial, { force: true })
  }
  flushFolder(dirname(to))
  unlinkSync(from)
}

/**
 * `link` then `unlink`, because `rename` replaces a file already at `to` and `link` refuses to. A crash
 * between the two leaves one file under both names, which the next start recognises and finishes.
 */
export const moveFile = (from: string, to: string) => {
  try {
    linkSync(from, to)
  } catch (error) {
    const code = errno(error)
    if (code === "EEXIST") throw conflict([[from, to]])
    if (code === "EXDEV") return copyAcross(from, to)
    if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(code ?? "")) throw error
    if (existsSync(to)) throw conflict([[from, to]])
    renameSync(from, to)
    return
  }
  unlinkSync(from)
}

const moveTree = (from: string, to: string) => {
  if (existsSync(to)) return
  try {
    renameSync(from, to)
    return
  } catch (error) {
    if (errno(error) !== "EXDEV") throw error
  }
  const partial = `${to}${PARTIAL}${process.pid}`
  try {
    cpSync(from, partial, { recursive: true, force: false, errorOnExist: true })
    for (const file of filesUnder(partial)) flush(join(partial, file))
    if (!sameTree(from, partial)) throw new Error(`the copy of ${from} at ${partial} came out different`)
    if (existsSync(to)) return
    renameSync(partial, to)
  } finally {
    rmSync(partial, { recursive: true, force: true })
  }
  flushFolder(dirname(to))
  rmSync(from, { recursive: true, force: true })
}

/** A db without its wal loses writes, so a failure part-way puts back what already moved. */
const moveAll = (names: string[], from: string, to: string, move: (from: string, to: string) => void) => {
  const done: string[] = []
  try {
    for (const name of names) {
      move(join(from, name), join(to, name))
      done.push(name)
    }
  } catch (error) {
    if (error instanceof Stop) throw error
    const stuck: string[] = []
    for (const name of done.reverse()) {
      try {
        move(join(to, name), join(from, name))
      } catch {
        stuck.push(join(to, name))
      }
    }
    if (stuck.length > 0)
      throw new Stop(
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

const LOCK_WAIT_MS = 60_000

const waitForLock = (path: string, waitMs: number) => {
  const until = Date.now() + waitMs
  for (;;) {
    const held = takeLock(path, { pid: process.pid, startedAt: new Date().toISOString() })
    if (!held) return
    if (Date.now() >= until)
      throw new Stop(`pid ${held.pid} is moving the store into ${dirname(path)} — run again once it finishes`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  }
}

let keptStore: string | undefined

/** The old store this run keeps using: a unit written now must not pin it, or the move never happens. */
export const keptOldStore = () => keptStore

const keepOld = (env: NodeJS.ProcessEnv, path: string) => {
  env.MESSAGING_STORE = path
  keptStore = path
}

interface MoveOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  warn?: (line: string) => void
  holders?: (oldState: string) => string[]
  move?: (from: string, to: string) => void
  lockWaitMs?: number
}

/**
 * Brings the store and the models, which lived in `cli-messaging`'s and `cli-common`'s folders, into the
 * WireCat folder. Never over a file already there, never when an override says where they are, and never
 * while something has the old store open: that run keeps using the old file. Two different stores stop
 * the command rather than pick one.
 */
export const migrateToWirecatFolder = (
  app: Pick<AppIdentity, "command" | "appName" | "envPrefix">,
  options: MoveOptions = {},
) => {
  const { env = process.env, platform = process.platform, move = moveFile, lockWaitMs = LOCK_WAIT_MS } = options
  const holdersOf = options.holders ?? ((dir: string) => storeHolders(dir, platform))
  const warn = options.warn ?? ((line: string) => process.stderr.write(`${line}\n`))
  if (env.MESSAGING_STORE || env.WIRECAT_STATE_DIR) return
  const target = wirecatDirectory(env)
  const oldState = resolvePaths({ appName: "cli-messaging", prefix: "MESSAGING", env }).state
  const oldDb = join(oldState, STORE)
  // A store under MESSAGING_STATE_DIR stays where the override put it; a test sandbox's must never reach home.
  const storeOverridden = env.MESSAGING_STATE_DIR !== undefined
  if (storeOverridden && existsSync(oldDb)) keepOld(env, oldDb)
  const oldModels = env.CLI_COMMON_CACHE_DIR
    ? undefined
    : join(resolvePaths({ appName: "cli-common", prefix: "CLI_COMMON", env }).cache, "models")
  const modelsToMove = oldModels !== undefined && existsSync(oldModels) && !existsSync(join(target, "models"))
  if ((storeOverridden || storeFiles(oldState).length === 0) && !modelsToMove) return

  mkdirSync(target, { recursive: true, mode: 0o700 })
  const lock = join(target, ".moving.lock")
  waitForLock(lock, lockWaitMs)
  try {
    for (const name of readdirSync(target).filter((entry) => entry.includes(PARTIAL)))
      rmSync(join(target, name), { recursive: true, force: true })
    try {
      if (!storeOverridden) moveStore(app, oldState, target, env, holdersOf, move, warn)
    } catch (error) {
      if (error instanceof Stop) throw error
      if (existsSync(oldDb) && !existsSync(join(target, STORE))) keepOld(env, oldDb)
      warn(`${app.command}: could not move the store to ${target} — ${(error as Error).message}`)
    }
    try {
      if (oldModels && existsSync(oldModels)) moveTree(oldModels, join(target, "models"))
    } catch (error) {
      warn(`${app.command}: could not move the models to ${target} — ${(error as Error).message}`)
    }
  } finally {
    releaseLock(lock)
  }
}

const moveStore = (
  app: Pick<AppIdentity, "command" | "appName" | "envPrefix">,
  oldState: string,
  target: string,
  env: NodeJS.ProcessEnv,
  holdersOf: (dir: string) => string[],
  move: (from: string, to: string) => void,
  warn: (line: string) => void,
) => {
  const all = storeFiles(oldState)
  const names = all.includes(STORE) ? all : all.filter((name) => !SIDECARS.includes(name))
  const pending: string[] = []
  const finished: string[] = []
  const conflicts: [string, string][] = []
  for (const name of names) {
    const [from, to] = [join(oldState, name), join(target, name)]
    if (!existsSync(to)) pending.push(name)
    else if (sameFile(from, to)) finished.push(name)
    else conflicts.push([from, to])
  }
  if (conflicts.length > 0) throw conflict(conflicts)
  // A wal or shm is only valid beside its own db: without the db moving, they stay where they are.
  const moving = pending.includes(STORE) ? pending : pending.filter((name) => !SIDECARS.includes(name))
  if (moving.length === 0 && finished.length === 0) return

  const serving = [
    ...[oldState, resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state].flatMap(liveServes),
    ...holdersOf(oldState),
  ]
  if (serving.length > 0) {
    if (existsSync(join(oldState, STORE))) keepOld(env, join(oldState, STORE))
    warn(
      `${app.command}: something has the store open (${serving.join(", ")}) — the store moves to ${target} on a run after it stops`,
    )
    return
  }
  moveAll(moving, oldState, target, move)
  for (const name of dbLast(finished)) unlinkSync(join(oldState, name))
}
