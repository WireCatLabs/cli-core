import { execFile, spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { CliError } from "@wirecat/cli-base"

export interface Ran {
  code: number
  stdout: string
  stderr: string
}

/** What `server` asks of the machine. Tests hand one in; nothing else does. */
/** What a run may hand the program besides its words: text on its stdin, and a time after which it is stopped. */
export interface RunOptions {
  input?: string
  timeoutMs?: number
}

/** The exit code a program stopped at `RunOptions.timeoutMs` answers, as `timeout(1)` does. */
export const TIMED_OUT = 124

export interface ServerSystem {
  platform: NodeJS.Platform
  run: (argv: string[], env: NodeJS.ProcessEnv, options?: RunOptions) => Promise<Ran>
  /** The command line that starts this CLI: the node binary and the script, both absolute. */
  entry: string[]
  uid: number
  /** Starts `<cli> <argv>` apart from this process, writing to `log`, and answers its PID. */
  spawn: (argv: string[], env: NodeJS.ProcessEnv, log: string) => number
  /** The pause between two looks at whether `serve` is listening yet. */
  pause: () => Promise<void>
}

export const runProgram = (
  argv: string[],
  env: NodeJS.ProcessEnv,
  { input, timeoutMs }: RunOptions = {},
): Promise<Ran> =>
  new Promise((resolve, reject) => {
    const [file = "", ...args] = argv
    const child = execFile(
      file,
      args,
      { env, encoding: "utf8", ...(timeoutMs ? { timeout: timeoutMs } : {}) },
      (error, stdout, stderr) => {
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
          reject(
            new CliError("configuration_error", `${file} was not found — this machine has no ${file} to run serve`),
          )
          return
        }
        const code = error?.killed ? TIMED_OUT : typeof error?.code === "number" ? error.code : error ? 1 : 0
        resolve({ code, stdout, stderr })
      },
    )
    // A program that does not read its stdin may close it first; that is no failure of the run.
    child.stdin?.on("error", () => {})
    if (input !== undefined) child.stdin?.end(input)
  })

export const thisMachine = (): ServerSystem => {
  // The path as the package manager's shim gave it, not resolved: pnpm's global link keeps its name across upgrades
  // while the folder it points at is versioned and removed by the next upgrade, which would leave the unit dead.
  const entry = [process.execPath, resolve(process.argv[1] ?? "")]
  return {
    platform: process.platform,
    run: runProgram,
    entry,
    uid: process.getuid?.() ?? 0,
    spawn: (argv, env, log) => {
      mkdirSync(dirname(log), { recursive: true, mode: 0o700 })
      const out = openSync(log, "a", 0o600)
      try {
        const [file = "", ...rest] = entry
        const child = spawn(file, [...rest, ...argv], { detached: true, stdio: ["ignore", out, out], env })
        child.unref()
        return child.pid ?? 0
      } finally {
        closeSync(out)
      }
    },
    pause: () => sleep(250),
  }
}
