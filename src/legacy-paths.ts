import { execFileSync } from "node:child_process"
import { cpSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative } from "node:path"
import { CliError } from "./errors.js"
import { PATH_KINDS, type Paths, type PathsOptions, pathsAreOverridden, resolvePaths } from "./paths.js"

export interface LegacyMove {
  kind: keyof Paths
  from: string
  to: string
  /** Copied across file systems rather than renamed: the old folder is still there. */
  copied: boolean
}

export interface MigrateLegacyPathsOptions extends PathsOptions {
  rename?: (from: string, to: string) => void
  /** The processes, as text, that hold files under `dirs` open; empty when none does. Defaults to lsof. */
  holders?: (dirs: string[]) => string[]
}

/** Where `env-paths` put each directory on macOS, before this package switched to XDG there. */
export const legacyMacPaths = (appName: string, env: NodeJS.ProcessEnv = process.env): Paths => {
  const library = join(env.HOME || homedir(), "Library")
  return {
    config: join(library, "Preferences", appName),
    state: join(library, "Application Support", appName),
    cache: join(library, "Caches", appName),
  }
}

const kindOf = (path: string) => {
  try {
    return lstatSync(path).isDirectory() ? "dir" : "other"
  } catch {
    return "none"
  }
}

const isFreeTarget = (path: string) => {
  const kind = kindOf(path)
  return kind === "none" || (kind === "dir" && readdirSync(path).length === 0)
}

// An absolute path: an MCP host may start the CLI with a PATH that has no /usr/sbin.
const LSOF = "/usr/sbin/lsof"

const runLsof = (args: string[]) => execFileSync(LSOF, args, { encoding: "utf8", timeout: 30_000, stdio: "pipe" })

/**
 * Only files open right now: a file written by path and closed again, like a lock or a journal,
 * is invisible here, so a caller that knows its own lock files should add them through `holders`.
 */
export const lsofHolders = (dirs: string[], run = runLsof): string[] =>
  dirs.flatMap((dir) => {
    let listed: string
    try {
      listed = run(["-t", "+D", dir])
    } catch (error) {
      // lsof exits 1 both when nothing is open and when it hit a warning; the PIDs are on stdout either way.
      const failure = error as { status?: number; stdout?: string; message: string }
      if (failure.status !== 1)
        throw new CliError(
          "configuration_error",
          `could not check whether a process has files open in ${dir}, so nothing was moved: ${failure.message}. ` +
            `Run \`lsof +D "${dir}"\`, stop what it lists, and run the command again.`,
        )
      listed = failure.stdout ?? ""
    }
    return listed
      .split("\n")
      .filter((pid) => pid && pid !== String(process.pid))
      .map((pid) => `pid ${pid} (${dir})`)
  })

const listTree = (root: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const path = join(entry.parentPath, entry.name)
      const stat = lstatSync(path)
      return `${relative(root, path)}:${stat.isDirectory() ? "dir" : stat.size}`
    })
    .sort()

/**
 * A copy goes to a sibling first and is renamed in only once checked: a half-written folder at
 * the new path would read as "already migrated" on the next start and hide the old data for good.
 */
const copyInto = (from: string, to: string) => {
  const draft = `${to}.migrating-${process.pid}`
  try {
    cpSync(from, draft, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true })
    if (listTree(from).join("\n") !== listTree(draft).join("\n")) throw new Error("the copy differs from the original")
    renameSync(draft, to)
  } catch (error) {
    rmSync(draft, { recursive: true, force: true })
    throw new CliError(
      "configuration_error",
      `could not copy ${from} to ${to}, nothing moved: ${(error as Error).message}`,
    )
  }
}

// Two CLIs starting together can race for the same folder, e.g. the shared store under cli-messaging.
const movedByAnother = (from: string, to: string) => kindOf(from) === "none" || !isFreeTarget(to)

/**
 * Moves the folders an earlier release kept under `~/Library` to the XDG ones `resolvePaths` now
 * gives on macOS. Call it once at program start, before anything resolves a path — a write that
 * creates the new folder first would leave the old data behind for good.
 *
 * It moves all pending folders or none, and throws when `holders` (lsof by default) shows a file
 * open in any of them: a running `serve` keeps writing into the folder it opened, and data it
 * writes after the move is lost. Cheap when there is nothing to do: one `lstat` per folder.
 */
export const migrateLegacyMacPaths = (options: MigrateLegacyPathsOptions): LegacyMove[] => {
  const {
    appName,
    env = process.env,
    platform = process.platform,
    rename = renameSync,
    holders = lsofHolders,
  } = options
  if (platform !== "darwin" || pathsAreOverridden(options)) return []

  const legacy = legacyMacPaths(appName, env)
  const current = resolvePaths({ ...options, env, platform })
  const pending = PATH_KINDS.filter(
    (kind) =>
      legacy[kind] !== current[kind] &&
      kindOf(legacy[kind]) === "dir" &&
      readdirSync(legacy[kind]).length > 0 &&
      isFreeTarget(current[kind]),
  )
  if (pending.length === 0) return []

  const busy = holders(pending.map((kind) => legacy[kind]))
  if (busy.length > 0)
    throw new CliError(
      "configuration_error",
      `${appName} now keeps its files outside ~/Library and must move ${pending.map((kind) => legacy[kind]).join(", ")} ` +
        `to ${pending.map((kind) => current[kind]).join(", ")}, but another process has files there open ` +
        `(${busy.join(", ")}). Stop it — a running \`serve\` or MCP server — and run the command again.`,
      { busy },
    )

  const moves: LegacyMove[] = []
  for (const kind of pending) {
    const from = legacy[kind]
    const to = current[kind]
    mkdirSync(dirname(to), { recursive: true })
    try {
      rename(from, to)
      moves.push({ kind, from, to, copied: false })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EXDEV") {
        copyInto(from, to)
        moves.push({ kind, from, to, copied: true })
      } else if (!movedByAnother(from, to)) {
        throw new CliError("configuration_error", `could not move ${from} to ${to}: ${(error as Error).message}`, {
          moved: moves,
        })
      }
    }
  }
  return moves
}
