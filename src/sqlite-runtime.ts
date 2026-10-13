import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import { CAPABILITY_STATEMENTS, storeCapable } from "./store/open.js"

const RESTARTED = "CLI_MESSAGING_SQLITE_RESTARTED"
const USER_LIBRARY_PATH = "CLI_MESSAGING_USER_LD_LIBRARY_PATH"
const FORWARDED = ["SIGTERM", "SIGHUP", "SIGQUIT"] as const

export interface SqliteRuntime {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  bun: boolean
  maps(): string
  capable(): Promise<boolean>
  library(musl: boolean): Promise<{ path: string; version: string } | undefined>
  works(env: NodeJS.ProcessEnv, version: string): boolean
  restart(env: NodeJS.ProcessEnv): Promise<never>
}

/**
 * Run first by `tg` and `max`, before their program is imported. A Linux distribution's Node takes
 * the system's `libsqlite3`; when that one cannot hold the store, the command starts again on the
 * SQLite of `@wirecat/cli-core-sqlite`. Restarting here, before anything is read or sent, is
 * what makes it safe — later in the command it could repeat an action.
 */
export const ensureSqlite = async (runtime: SqliteRuntime = nodeRuntime()): Promise<void> => {
  const { env } = runtime
  if (env[RESTARTED]) {
    // Programs this one starts get the user's search path back, and check their own SQLite.
    if (env[USER_LIBRARY_PATH] === undefined) delete env.LD_LIBRARY_PATH
    else env.LD_LIBRARY_PATH = env[USER_LIBRARY_PATH]
    delete env[USER_LIBRARY_PATH]
    delete env[RESTARTED]
    return
  }
  // Official Node builds SQLite in: nothing to swap, and nothing to pay for asking.
  if (runtime.bun || runtime.platform !== "linux") return
  const maps = runtime.maps()
  if (!maps.includes("libsqlite3")) return
  if (await runtime.capable()) return

  const library = await runtime.library(maps.includes("ld-musl"))
  if (!library) return
  const restarted: NodeJS.ProcessEnv = {
    ...env,
    LD_LIBRARY_PATH: [dirname(library.path), env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
    [RESTARTED]: "1",
  }
  if (env.LD_LIBRARY_PATH !== undefined) restarted[USER_LIBRARY_PATH] = env.LD_LIBRARY_PATH
  // A library that does not load would crash the command before any of our code runs; the store's
  // own check refuses with a message instead.
  if (!runtime.works(restarted, library.version)) return
  await runtime.restart(restarted)
}

const trialScript = (version: string) => `
  const { DatabaseSync } = await import("node:sqlite")
  const database = new DatabaseSync(":memory:")
  if (database.prepare("SELECT sqlite_version() AS v").get().v !== ${JSON.stringify(version)}) process.exit(1)
  for (const statement of ${JSON.stringify(CAPABILITY_STATEMENTS)}) database.exec(statement)
`

export const nodeRuntime = (): SqliteRuntime => ({
  env: process.env,
  platform: process.platform,
  bun: "Bun" in globalThis,
  maps: () => {
    try {
      return readFileSync("/proc/self/maps", "utf8")
    } catch {
      return ""
    }
  },
  capable: () =>
    storeCapable().then(
      () => true,
      () => false,
    ),
  library: async (musl) => {
    try {
      const { libraryFor, SQLITE_VERSION } = await import("@wirecat/cli-core-sqlite")
      const path = libraryFor({ musl })
      return path === undefined ? undefined : { path, version: SQLITE_VERSION }
    } catch {
      return undefined
    }
  },
  works: (env, version) =>
    spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", trialScript(version)], {
      env,
      stdio: "ignore",
      timeout: 10_000,
    }).status === 0,
  restart: (env) =>
    relay(spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { env, stdio: "inherit" })),
})

/**
 * The parent stays while the command runs in the child: it passes on what stops it — an MCP client
 * or `kill <pid>` signals the process it started — and leaves with the child's code or signal. The
 * terminal sends Ctrl-C to both, so the parent ignores SIGINT and waits.
 */
export const relay = (
  child: ChildProcess,
  host: Pick<NodeJS.Process, "on" | "exit" | "kill" | "pid" | "removeAllListeners"> = process,
): Promise<never> =>
  new Promise<never>(() => {
    for (const signal of FORWARDED) host.on(signal, () => child.kill(signal))
    host.on("SIGINT", () => {})
    child.on("error", () => host.exit(1))
    child.on("exit", (code, signal) => {
      if (signal) {
        host.removeAllListeners(signal)
        host.kill(host.pid, signal)
      } else host.exit(code ?? 1)
    })
  })
