import { join } from "node:path"
import {
  CliError,
  errorObjectOf,
  errorRecordOf,
  exitCodeFor,
  exitCodeOfError,
  processStreams,
  renderError,
  resolvePaths,
  type Streams,
} from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import { skillHint } from "@wirecat/cli-base/skill"
import { Command } from "commander"
import { failingNotice, scheduledRuns } from "../background/schedules.js"
import { parseDuration } from "../domain/duration.js"
import { isCliFailure, isCommanderFailure } from "../errors/failures.js"
import { failureContext } from "../errors/reasons.js"
import { type AppIdentity, envName, readOnlyLockOf } from "../ports/app.js"
import { recorded, wasSettled } from "../runs/recording.js"
import { commandPathOf } from "./command-contract.js"
import { type BaseEnvironment, outputFor, provide } from "./context.js"
import { changesAuthority, judgedEffects, judgedTargets } from "./effects.js"
import { itemOf, renderAnswer, snakeKeys } from "./envelope.js"
import { byteCount, DEFAULT_COMMAND_MS, DEFAULT_OUTPUT_BYTES, execution } from "./execution.js"
import { MAX_BUFFERED_INPUT, provideInputPolicy } from "./input-policy.js"
import { checkJson, liftJson } from "./json-fields.js"
import { movedPath, movedPointer } from "./moved.js"
import { PreviewComplete, preview } from "./preview.js"
import { commandWords, liftProfile } from "./profile.js"
import { type GlobalFlags, type ResolveOptions, type Settings, settingsFor } from "./settings.js"
import { commandAt } from "./steps.js"

export interface ProgramDefinition {
  app: AppIdentity
  /** One resource per command, one action per subcommand. Built fresh for every program. */
  commands: () => Command[]
  /** The CLI's own settings, for keeping a failure that happened before its command could; plain ones without. */
  configuration?: {
    resolveSettings: (
      flags?: GlobalFlags,
      options?: ResolveOptions,
    ) => Pick<Settings, "profile" | "keepFailedRuns" | "keepRunsForDays" | "skillHint">
  }
  configure?: (program: Command) => void
  prepare?: (program: Command, environment: RunOptions) => void | Promise<void>
  onFailure?: (error: unknown, program: Command) => void | Promise<void>
}

export interface ProgramOptions {
  /** Where `--version` and `--help` write. Injected so a test reads them instead of the terminal. */
  out?: (text: string) => void
  err?: (text: string) => void
}

/**
 * The command tree, built fresh on each call. Commander is global state by default —
 * `exitOverride` and the write hooks turn it into a value a test can drive.
 */
export const createProgram = (
  { app, commands, configure }: ProgramDefinition,
  { out, err }: ProgramOptions = {},
): Command => {
  const program = new Command()

  program
    .name(app.command)
    .usage("[profile] [options] <command>")
    .description(
      `${app.description}\n\n` +
        `The first word is the profile whenever it is not a command — \`${app.command} personal chats list\`.\n` +
        `\`${app.envPrefix}_PROFILE\` says the same thing for a whole shell session, and \`default_profile\` in the config file for good.\n` +
        "No profile is assumed: without one, a command that uses an account stops and lists the profiles here.",
    )
    .version(app.version, "-V, --version")
    .option(
      "-v, --verbose",
      "more detail in what is shown: -v ids, -vv everything we know",
      (_, level: number) => level + 1,
      0,
    )
    .option("--json", "machine-readable output: one JSON value on stdout; --json=id,text keeps only those fields")
    .option("--jsonl", "machine-readable output: one JSON object per line, for streaming and jq")
    .option("--quiet", "diagnostics off; a failure is still said")
    .option("--trace", "the connection's own log lines on stderr — never message content")
    .option("--debug", "on a failure, its whole record — cause and stack — in place of the short line")
    .option("--timeout <duration>", "give up on the whole command after this — 30s, 2m, 500ms")
    .option("--offline", "answer from what was recorded and never connect; fails if nothing was")
    .option("--no-input", "never prompt or open interactive login; piped input remains available")
    .option("--max-input-bytes <bytes>", "maximum buffered input bytes (default: 16777216)")
    .option("--max-output-bytes <bytes>", "maximum machine output bytes (default: 4194304; 0 disables)")
    .option("--brief", "found messages and mail as reference, title, time, sender and excerpt only")
    .option("--full", "found messages and mail with their whole text and every provider field")
    .option("--dry-run", "preview parsed arguments and permissions before running the action")
    .option("--yes", "go ahead without the question an ask level puts before a write")
    .option("--record", "keep this run — ids and timings, never message content")
    .option("--no-record", "do not keep it, whatever the configuration says")
    .showHelpAfterError()

  for (const command of commands()) program.addCommand(command)
  configure?.(program)

  // Depth-first: Commander does not pass `configureOutput` down to a command added with
  // `addCommand`, so `tg messages --help` would write to the real terminal.
  if (out || err) {
    forEachCommand(program, (command) =>
      command.configureOutput({ writeOut: (text) => out?.(text), writeErr: (text) => err?.(text) }),
    )
  }
  return program
}

const forEachCommand = (command: Command, apply: (command: Command) => void): void => {
  apply(command)
  for (const child of command.commands) forEachCommand(child, apply)
}

export type RunOptions = BaseEnvironment & Record<string, unknown>

/**
 * Runs the program and **returns an exit code instead of throwing**. A stack trace is not an error
 * message: it tells a script nothing it can branch on, and exits 1 for every kind of failure alike.
 */
export const run = async (argv: string[], definition: ProgramDefinition, options: RunOptions = {}): Promise<number> => {
  const streams = options.streams ?? processStreams
  const delimiter = argv.indexOf("--")
  const flags = argv.slice(0, delimiter < 0 ? undefined : delimiter)
  const machine = flags.some((word) => word === "--json" || word.startsWith("--json=") || word === "--jsonl")
  const debug = flags.includes("--debug")
  const reporting = machine ? { ...options, tty: false } : options
  const control = execution(streams, { maxOutputBytes: 0 })
  let restoreInput: (() => void) | undefined
  let signalExit: number | undefined
  // Ctrl-C or `kill` is how a command that listens until stopped ends: still aborted, but exit 0.
  let listens = false
  const interrupted = (signal: "SIGINT" | "SIGTERM") => {
    signalExit = listens ? 0 : signal === "SIGINT" ? 130 : 143
    control.abort(new CliError("cancelled", `command interrupted by ${signal}`, { reason: signal, retryable: false }))
  }
  const sigint = () => interrupted("SIGINT")
  const sigterm = () => interrupted("SIGTERM")
  const pipeError = (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      signalExit = 0
      control.abort(error)
    }
  }
  const externalAbort = () => control.abort(new CliError("cancelled", "command cancelled", { retryable: false }))
  const { command } = definition.app
  // Commander's own error lines are replaced by ours; its help for a missing subcommand is kept for a person.
  let help = ""
  const program = createProgram(definition, {
    out: (text) => control.streams.data(text.replace(/\n$/, "")),
    err: (text) => {
      help += text
    },
  })
  const environment: RunOptions = {
    ...options,
    streams: control.streams,
    signal: options.signal ? AbortSignal.any([control.signal, options.signal]) : control.signal,
    commandSignal: control.signal,
    trackCloseable: control.trackCloseable,
    app: definition.app,
  }
  provide(program, environment)
  program.hook("preAction", async (_root, action) => {
    const flags = action.optsWithGlobals<
      GlobalFlags & {
        input?: boolean
        maxInputBytes?: string
        maxOutputBytes?: string
        fields?: string
        dryRun?: boolean
      }
    >()
    const commandEnv = options.env ?? process.env
    const headless =
      machine || flags.input === false || Boolean(commandEnv.CI) || (options.tty ?? process.stdout.isTTY) !== true
    checkJson(action, requested, !flags.jsonl && (options.tty ?? process.stdout.isTTY) === true)
    control.configure({
      ...(flags.fields === undefined ? {} : { fields: flags.fields }),
      maxOutputBytes:
        flags.maxOutputBytes === undefined
          ? machine || (options.tty ?? process.stdout.isTTY) !== true
            ? DEFAULT_OUTPUT_BYTES
            : 0
          : byteCount(flags.maxOutputBytes, "--max-output-bytes", true),
    })
    restoreInput = provideInputPolicy(options.stdin ?? process.stdin, {
      noInput: headless,
      maxBytes:
        flags.maxInputBytes === undefined ? MAX_BUFFERED_INPUT : byteCount(flags.maxInputBytes, "--max-input-bytes"),
      signal: control.signal,
    })
    if (flags.input === false || (headless && !options.answer)) environment.answer = () => null
    const localPreview = action.options.some((option) => option.long === "--dry-run")
    if (flags.dryRun && localPreview) action.setOptionValue("dryRun", true)
    const path = commandPathOf(action)
    const lock = readOnlyLockOf(definition.app, commandEnv)
    if (lock && changesAuthority(action) && !flags.dryRun)
      throw new CliError(
        "permission_error",
        `this process is read-only (${lock}) — \`${command} ${path.join(" ")}\` changes what a later run may do; ` +
          `run it without ${lock}`,
      )
    const { lifetime, cooperative: stopsAtItsPace } = metaOf(action)
    const persistent = lifetime === "persistent"
    listens = persistent
    const interactiveLogin = !headless && lifetime === "interactive"
    const timeout = flags.timeout ?? (commandEnv[envName(definition.app, "TIMEOUT")]?.trim() || undefined)
    // A background fetch was asked to outlive the shell; only an explicit --timeout bounds it.
    const job = commandEnv[envName(definition.app, "BACKFILL_JOB")] !== undefined
    control.start(
      timeout === undefined
        ? persistent || interactiveLogin || job
          ? undefined
          : DEFAULT_COMMAND_MS
        : persistent
          ? undefined
          : parseDuration(timeout, flags.timeout === undefined ? envName(definition.app, "TIMEOUT") : "--timeout"),
    )
    process.on("SIGINT", sigint).on("SIGTERM", sigterm)
    if (!options.streams) {
      process.stdout.on("error", pipeError)
      process.stderr.on("error", pipeError)
    }
    const cooperative = persistent || stopsAtItsPace === true
    if (!cooperative) options.signal?.addEventListener("abort", externalAbort, { once: true })
    if (!cooperative && options.signal?.aborted) {
      externalAbort()
      throw control.failure()
    }
    if (flags.dryRun && !localPreview) {
      const resolved = (definition.configuration ?? settingsFor(definition.app)).resolveSettings(flags, {
        kind: path[0] === "bot" ? "bot" : "personal",
        env: options.env ?? process.env,
        readOnly: true,
      })
      const permissions = "permissions" in resolved ? (resolved.permissions as Settings["permissions"]) : {}
      renderAnswer(action, outputFor(action), itemOf(snakeKeys(preview(action, permissions))))
      throw new PreviewComplete()
    }
    // Not inside the scheduled run itself: its own failure is already on its way to last.json.
    if (!flags.quiet && commandEnv[envName(definition.app, "SCHEDULED")] === undefined && path[0] !== "schedule") {
      const notice = failingNoticeFor(definition.app, commandEnv)
      if (notice) streams.diagnostic(notice)
    }
    await definition.prepare?.(program, environment)
    if (control.signal.aborted) throw control.failure()
  })
  // Depth-first: a subcommand left with the default behaviour kills the process from inside a test.
  forEachCommand(program, (child) => child.exitOverride())

  // Before commander, not inside it: commander has no hook that runs before it decides which
  // subcommand it is looking at.
  const { profile, rest: lifted } = liftProfile(argv, commandWords(program))
  if (profile !== undefined) program.setOptionValue("profile", profile)
  const requested = liftJson(lifted, (words) => commandAt(program, commandPath(program, words)))
  const rest = requested.argv
  if (requested.fields !== undefined) program.setOptionValue("fields", requested.fields)

  // A bare word with nothing after it would make commander print help **on stdout**, which breaks
  // the one contract this program has and says nothing about why.
  if (profile !== undefined && rest.length === 0) {
    const message =
      `"${profile}" is not a command, so it was read as a profile name — and no command followed it. ` +
      `Run \`${command} --help\` for the commands, or \`${command} ${profile} account show\` if "${profile}" is your profile.`
    const failure = new CliError("validation_error", message, { param: "profile" })
    const settled = await settleFailure(failure, { definition, program, rest, profile, options })
    return report(streams, reporting, failed(definition, program, rest, failure, settled, debug))
  }

  const words = rest.filter((word) => !word.startsWith("-"))
  const moved = movedPath(words, (path) => mountedOrArgument(program, path))
  if (moved !== undefined) {
    const failure = new CliError("validation_error", `\`${command} ${moved}\` is not here — ${movedPointer(moved)}`)
    const settled = await settleFailure(failure, { definition, program, rest, profile, options })
    return report(streams, reporting, failed(definition, program, rest, failure, settled, debug))
  }

  try {
    await control.race(() => program.parseAsync(rest, { from: "user" }))
    const code = process.exitCode === undefined ? 0 : Number(process.exitCode)
    const hint =
      code === 0 && rest[0] !== "commands" && !rest.includes("--quiet") ? hintFor(definition, rest, options) : undefined
    if (hint) streams.diagnostic(hint)
    return code
  } catch (caught) {
    const error = control.failure() ?? caught
    if (error instanceof PreviewComplete) return 0
    if (signalExit === 0) return 0
    if (isCommanderFailure(error)) {
      if (error.exitCode === 0) return 0
      let message = error.message.replace(/^error: /, "")
      if (error.code === "commander.help") {
        if (reporting.tty ?? process.stdout.isTTY === true) {
          streams.diagnostic(help.replace(/\n$/, ""))
          return exitCodeFor("validation_error")
        }
        message = `give a command — run \`${command} --help\` for the commands`
      }
      if (
        profile !== undefined &&
        error.code === "commander.unknownCommand" &&
        rest[0] !== undefined &&
        !commandWords(program).has(rest[0])
      ) {
        message += ` "${profile}" is not a command, so it was read as a profile name — which left "${rest[0]}" to be one.`
      }
      const failure = new CliError("validation_error", message)
      const settled = await settleFailure(failure, { definition, program, rest, profile, options })
      return report(streams, reporting, failed(definition, program, rest, failure, settled, debug))
    }
    const settled = await settleFailure(error, { definition, program, rest, profile, options })
    const exit = report(streams, reporting, failed(definition, program, rest, error, settled, debug))
    return signalExit ?? exit
  } finally {
    restoreInput?.()
    options.signal?.removeEventListener("abort", externalAbort)
    process.off("SIGINT", sigint).off("SIGTERM", sigterm)
    if (!options.streams) {
      process.stdout.off("error", pipeError)
      process.stderr.off("error", pipeError)
    }
    await control.finish()
  }
}

const failingNoticeFor = (app: AppIdentity, env: NodeJS.ProcessEnv) => {
  try {
    const state = resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state
    return failingNotice(app.command, scheduledRuns(state), `${app.command} schedule list`)
  } catch {
    return undefined
  }
}

/** The update notice's state file, so both daily lines share one file per CLI. */
const hintFor = ({ app, configuration }: ProgramDefinition, argv: string[], options: RunOptions) => {
  const env = options.env ?? process.env
  let enabled: boolean
  try {
    enabled = (configuration ?? settingsFor(app)).resolveSettings(
      {},
      { env, needsProfile: false, readOnly: true },
    ).skillHint
  } catch {
    return undefined
  }
  const statePath = join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "update-check.json")
  return skillHint({ app, argv, env, statePath, enabled })
}

interface Failed {
  definition: ProgramDefinition
  program: Command
  rest: string[]
  profile: string | undefined
  options: RunOptions
}

const settleFailure = async (failure: unknown, state: Failed): Promise<{ settlementFailed?: true }> => {
  let timer: NodeJS.Timeout | undefined
  let settlementFailed: true | undefined
  try {
    const settle = (async () => {
      try {
        await state.definition.onFailure?.(failure, state.program)
      } catch {
        settlementFailed = true
      }
      await keepFailure(failure, state)
    })()
    await Promise.race([
      settle,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("failure settlement deadline")), 1000)
      }),
    ])
    return settlementFailed ? { settlementFailed } : {}
  } catch {
    return { settlementFailed: true }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * **Every failure is kept as a run** — a usage error, a configuration that will not load, a command
 * that never opens a run — unless recording was turned off. One its own run already kept is skipped.
 * Only the command's words are named, never its arguments: those can be a message.
 */
const keepFailure = async (
  failure: unknown,
  { definition, program, rest, profile, options }: Failed,
): Promise<void> => {
  if (wasSettled(failure)) return
  const env = options.env ?? process.env
  const path = commandPath(program, program.args.length > 0 ? program.args : rest)
  const { resolveSettings } = definition.configuration ?? settingsFor(definition.app)
  let settings: ReturnType<typeof resolveSettings> | undefined
  try {
    settings = resolveSettings(
      { ...program.opts(), ...(profile === undefined ? {} : { profile }) },
      { env, kind: path.split(" ")[0] === "bot" ? "bot" : "personal", needsProfile: false, readOnly: true },
    )
  } catch {
    // A configuration that will not load is a failure worth keeping too; the flags are all there is to go on.
  }
  await recorded(
    {
      app: definition.app,
      command: path || definition.app.command,
      profile: settings?.profile ?? profile ?? "default",
      record: false,
      keepFailed: settings?.keepFailedRuns ?? !rest.includes("--no-record"),
      trace: false,
      format: "json",
      streams: options.streams ?? processStreams,
      env,
      ...(settings ? { keepDays: settings.keepRunsForDays } : {}),
    },
    async () => {
      throw failure
    },
  ).catch(() => {})
}

/** Mounted, or reached through a command that takes no subcommand, where the rest of the path is its argument. */
const mountedOrArgument = (program: Command, path: string): boolean => {
  const words = path.split(" ")
  return words.some((_, at) => {
    const command = commandAt(program, words.slice(0, at + 1).join(" "))
    return command !== undefined && (at === words.length - 1 || command.commands.length === 0)
  })
}

/** `messages list` from `messages list 111 --limit 5`: the words that name commands, up to the first that does not. */
const commandPath = (program: Command, rest: string[]): string => {
  const words: string[] = []
  let current = program
  for (const token of rest) {
    if (token.startsWith("-")) continue
    const next = current.commands.find((one) => one.name() === token || one.aliases().includes(token))
    if (!next) break
    words.push(token)
    current = next
  }
  return words.join(" ")
}

interface Failure {
  object: ReturnType<typeof errorObjectOf>
  record?: ReturnType<typeof errorRecordOf>
  cli: string
}

const failed = (
  { app }: ProgramDefinition,
  program: Command,
  rest: string[],
  error: unknown,
  settled: { settlementFailed?: true },
  debug: boolean,
): Failure => {
  const failure =
    settled.settlementFailed && isCliFailure(error)
      ? new CliError(error.code, error.message, { ...error.details, settlement_failed: true })
      : error
  const path = commandPath(program, program.args.length > 0 ? program.args : rest)
  const effects = judgedEffects(path ? metaOf(commandAt(program, path) ?? program).effects : undefined)
  const object = errorObjectOf(failure, {
    ...failureContext(app.errors),
    targets: judgedTargets(program),
    ...(effects ? { effects } : {}),
  })
  const command = path || app.command
  return {
    object,
    cli: app.command,
    ...(debug
      ? { record: errorRecordOf(failure, object, { command, service: app.command, version: app.version }) }
      : {}),
  }
}

/**
 * **A failure never reaches stdout.** It goes to stderr — as JSON when nobody is watching, because
 * an exit code says which kind of thing went wrong and nothing about which chat or how long to wait.
 */
const report = (streams: Streams, options: BaseEnvironment, { object, record, cli }: Failure): number => {
  const interactive = options.tty ?? process.stdout.isTTY === true
  streams.diagnostic(renderError(object, { cli, interactive, ...(record ? { record } : {}) }))
  return exitCodeOfError(object)
}
