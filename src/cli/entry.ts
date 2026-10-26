import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process"
import { CliError, catchCrashes } from "@wirecat/cli-base"
import type { ErrorReason } from "@wirecat/cli-base/standards"
import type { Command } from "commander"
import { type AppIdentity, envName, readOnlyLockOf } from "../ports/app.js"
import { ensureSqlite } from "../sqlite-runtime.js"
import { logVersion } from "./argv-log.js"

export type { AppIdentity }

/** What `startCli` hands the CLI's own program: the process, wired once. */
export interface EntryContext {
  /** `process.argv` without the runtime and the script. */
  args: string[]
  env: NodeJS.ProcessEnv
  /** Whether stdout is a terminal. */
  tty: boolean
  /** Aborted on SIGINT, SIGTERM and a closed or failing stdout. */
  signal: AbortSignal
  /** The first-run questions, before the command acts: call it from a `preAction` hook with the action command. */
  atStart: (command: Command) => Promise<void>
  /** A yes/no question on stderr; false without asking when there is no terminal, under CI, `--json`, `--jsonl` or `--no-input`. */
  ask: (question: string, command?: Command) => Promise<boolean>
  /** Opens the URL in the system browser, or in `browser` when given; never waits for the browser to close. */
  openBrowser: (url: string, browser?: string) => Promise<void>
  /** True once a reader closed the output (`| head`): nothing more reaches the terminal. */
  outputClosed: () => boolean
}

/** The parts of the process `startCli` touches, replaced in tests. */
export interface EntryIo {
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  stdout: NodeJS.WritableStream & { isTTY?: boolean }
  stderr: NodeJS.WritableStream & { isTTY?: boolean }
  signals: Pick<NodeJS.Process, "on" | "off">
  setExitCode: (code: number) => void
  spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
}

export interface CliEntry {
  app: AppIdentity
  /** Builds and runs the CLI's program; a returned number is the exit code, nothing keeps the one already set. */
  run: (entry: EntryContext) => Promise<number | undefined>
  /** Says a failure the program threw, once, and gives its exit code. */
  fail: (error: unknown, entry: EntryContext) => number
  /** Whether a crash may print the human form; stdout being a terminal when left out. */
  interactive?: (args: readonly string[], tty: boolean) => boolean
  reasons?: readonly ErrorReason[]
  /** Swap a system SQLite that cannot hold the store before anything runs (`ensureSqlite`). */
  sqlite?: boolean
  io?: Partial<EntryIo>
}

const processIo = (): EntryIo => ({
  argv: process.argv,
  env: process.env,
  platform: process.platform,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  signals: process,
  setExitCode: (code) => {
    process.exitCode = code
  },
  spawn,
})

/**
 * The entry point of a CLI that builds its own commander program: crash catch, cancellation, a quiet end on a closed
 * pipe, the first-run questions, the consent prompt and the browser. It sets `process.exitCode` and never exits, so
 * output still flushes.
 */
export const startCli = async (entry: CliEntry): Promise<void> => {
  const io = { ...processIo(), ...entry.io }
  const args = io.argv.slice(2)
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) return printVersion(entry.app, io)
  const tty = io.stdout.isTTY === true
  const release = catchCrashes({
    cli: entry.app.command,
    interactive: entry.interactive?.(args, tty) ?? tty,
    ...(entry.reasons ? { reasons: entry.reasons } : {}),
    target: io.signals,
  })
  const controller = new AbortController()
  let closed = false
  let unwritable = false
  const interrupted = (signal: "SIGINT" | "SIGTERM") => () =>
    controller.abort(
      new CliError("cancelled", `command interrupted by ${signal}`, { reason: signal, retryable: false }),
    )
  const sigint = interrupted("SIGINT")
  const sigterm = interrupted("SIGTERM")
  const outputFailed = (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      closed = true
      controller.abort(new CliError("cancelled", "output pipe closed", { retryable: false }))
    } else {
      unwritable = true
      controller.abort(new CliError("configuration_error", "could not write command output"))
    }
  }
  const headless = (command?: Command) => {
    const flags = command?.optsWithGlobals() ?? {}
    return Boolean(flags.json || flags.jsonl || flags.input === false || io.env.CI) || !tty
  }
  const context: EntryContext = {
    args,
    env: io.env,
    tty,
    signal: controller.signal,
    atStart: async (command) => {
      // The first-run questions write the shared config; a dry run writes nothing.
      if (command.optsWithGlobals<{ dryRun?: boolean }>().dryRun === true) return
      const [{ setupAtStart }, { commandPathOf }] = await Promise.all([
        import("./first-run.js"),
        import("./command-contract.js"),
      ])
      await setupAtStart({
        command: entry.app.command,
        env: io.env,
        contentLanguages: entry.app.contentLanguages,
        path: commandPathOf(command),
        headless: headless(command),
        readOnlyLock: readOnlyLockOf(entry.app, io.env),
        input: io.stdin,
      })
    },
    ask: async (question, command) => {
      if (headless(command) || io.stdin.isTTY !== true) return false
      const { readSecret } = await import("../terminal/prompt.js")
      const answer = await readSecret(`${question} [y/N] `, {
        input: io.stdin,
        output: io.stderr,
        echo: true,
        signal: controller.signal,
      })
      return /^(y|yes)$/i.test(answer.trim())
    },
    openBrowser: (url, browser) => openBrowser(io, url, browser),
    outputClosed: () => closed,
  }
  let code: number | undefined
  try {
    if (entry.sqlite) await ensureSqlite()
    io.signals.on("SIGINT", sigint).on("SIGTERM", sigterm)
    io.stdout.on("error", outputFailed)
    io.stderr.on("error", outputFailed)
    const returned = await entry.run(context)
    if (typeof returned === "number") code = returned
  } catch (error) {
    code = commanderExit(error) ?? entry.fail(error, context)
  } finally {
    io.signals.off("SIGINT", sigint).off("SIGTERM", sigterm)
    release()
  }
  // The listeners stay: output still flushing after the command can meet the closed pipe too.
  if (closed) io.setExitCode(0)
  else if (unwritable) io.setExitCode(3)
  else if (code !== undefined) io.setExitCode(code)
}

/**
 * Answered before the program loads, which is most of a start: an agent asks for the version to learn whether the
 * tool is there at all. Only the bare flag — anything else on the line goes through the program as before.
 */
const printVersion = (app: AppIdentity, io: EntryIo): void => {
  const argvLog = io.env[envName(app, "TEST_ARGV_LOG")]
  if (argvLog) logVersion(argvLog)
  io.stdout.write(`${app.version}\n`)
}

/** Help and the version were printed already; help for a missing command is a usage mistake, as in `run()`. */
const commanderExit = (error: unknown): number | undefined => {
  if (!(error instanceof Error)) return undefined
  const { code, exitCode } = error as { code?: unknown; exitCode?: unknown }
  if (typeof code !== "string" || !code.startsWith("commander.") || typeof exitCode !== "number") return undefined
  if (exitCode === 0) return 0
  return code === "commander.help" ? 2 : undefined
}

const openBrowser = (io: EntryIo, url: string, browser?: string): Promise<void> => {
  const [command, prefix] =
    browser !== undefined
      ? [browser, []]
      : io.platform === "darwin"
        ? ["open", []]
        : io.platform === "win32"
          ? ["rundll32.exe", ["url.dll,FileProtocolHandler"]]
          : ["xdg-open", []]
  return new Promise((resolve, reject) => {
    const child = io.spawn(command, [...prefix, url], { detached: true, stdio: "ignore", windowsHide: true })
    child.once("error", () =>
      reject(new CliError("configuration_error", `could not start ${command} — open the printed URL in a browser`)),
    )
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  })
}
