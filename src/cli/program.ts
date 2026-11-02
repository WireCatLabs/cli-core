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
import { metaOf, refuseJoinedPath } from "@wirecat/cli-base/commands"
import { skillHint } from "@wirecat/cli-base/skill"
import { COMPACT_FLAG } from "@wirecat/cli-base/standards"
import { Command, Help } from "commander"
import { relayCommand } from "../background/relay.js"
import { failingNotice, scheduledRuns } from "../background/schedules.js"
import { parseDuration } from "../domain/duration.js"
import { isCliFailure, isCommanderFailure } from "../errors/failures.js"
import { failureContext } from "../errors/reasons.js"
import { type AppIdentity, envName, readOnlyLockOf, readOnlyRefusal } from "../ports/app.js"
import { recorded, wasSettled } from "../runs/recording.js"
import { runContextOf } from "../runs/run-context.js"
import { processRun, useAsProcessRun } from "../runs/scope.js"
import { AUTHORITY_KEY, BOT_API_KEY, isBotApi, keyForCommand } from "../sends/permissions.js"
import { logParsedArgv, logVersion } from "./argv-log.js"
import { commandAvailability } from "./command-availability.js"
import { commandPathOf } from "./command-contract.js"
import { entityRows, type RowTable } from "./compact.js"
import { type BaseEnvironment, outputFor, provide } from "./context.js"
import { refuseByCommandPermissions, refuseWriteBeforeConnecting } from "./early-refusal.js"
import {
  changesAuthorityAt,
  changesAuthorityNow,
  isLogin,
  isStoreChange,
  judgedEffects,
  judgedTargets,
  storeChangeRefusal,
} from "./effects.js"
import { itemOf, renderAnswer, snakeKeys } from "./envelope.js"
import {
  byteCount,
  DEFAULT_AGENT_COOPERATIVE_MS,
  DEFAULT_COMMAND_MS,
  DEFAULT_COOPERATIVE_MS,
  DEFAULT_OUTPUT_BYTES,
  DEFAULT_SYNC_MS,
  execution,
} from "./execution.js"
import { setupAtStart } from "./first-run.js"
import { type FirstScreen, installHelp } from "./help/first-screen.js"
import { showInputFields } from "./input-fields.js"
import { MAX_BUFFERED_INPUT, provideInputPolicy } from "./input-policy.js"
import { checkJson, liftJson } from "./json-fields.js"
import type { CommandPermissions } from "./permission-keys.js"
import { PreviewComplete, preview } from "./preview.js"
import { commandWords, isProfileName, liftProfile, sampleCommand, takesProfile, valuedOptions } from "./profile.js"
import { absolutePaths, relayTarget } from "./relay-route.js"
import {
  type GlobalFlags,
  NoProfileHere,
  namedProfile,
  type ResolveOptions,
  type Settings,
  settingsFor,
} from "./settings.js"
import { assertSharedContracts } from "./shared-contracts.js"
import { skillSourceOf } from "./skill-command.js"
import { refreshSkills, skipsSkillRefresh } from "./skill-refresh.js"
import { commandAt, failureSteps, lineOf, withLines } from "./steps.js"

export interface ProgramDefinition {
  app: AppIdentity
  /** One resource per command, one action per subcommand. Built fresh for every program. */
  commands: () => Command[]
  /** The CLI's own settings, for keeping a failure that happened before its command could; plain ones without. */
  configuration?: {
    permissionKey?: (path: readonly string[]) => string | null | undefined
    /** A CLI's own keys (`commandPermissions`), from `settingsFor`: its commands are refused by them before they run. */
    permissions?: CommandPermissions | undefined
    resolveSettings: (
      flags?: GlobalFlags,
      options?: ResolveOptions,
    ) => Pick<Settings, "profile" | "keepFailedRuns" | "keepRunsForDays" | "skillHint"> &
      Partial<
        Pick<
          Settings,
          | "recordInput"
          | "keepSuccessfulRunsForDays"
          | "permissions"
          | "permissionSources"
          | "configPath"
          | "savedPermissions"
          | "sources"
        >
      >
  }
  configure?: (program: Command) => void
  /** The app's own rows for `--compact`, by entity name; a shared entity's name is refused. */
  rows?: RowTable
  /** The tool's pitch and "what you can do" lines on `--help` and a bare run. */
  firstScreen?: FirstScreen
  prepare?: (program: Command, environment: RunOptions) => void | Promise<void>
  onFailure?: (error: unknown, program: Command) => void | Promise<void>
}

export interface ProgramOptions {
  /** Where `--version` and `--help` write. Injected so a test reads them instead of the terminal. */
  out?: (text: string) => void
  err?: (text: string) => void
}

// An MCP server builds the tree on every tool call; the contracts of one definition's tree do not change between builds.
const contractsChecked = new WeakSet<ProgramDefinition>()

/**
 * The command tree, built fresh on each call. Commander is global state by default —
 * `exitOverride` and the write hooks turn it into a value a test can drive.
 */
export const createProgram = (definition: ProgramDefinition, { out, err }: ProgramOptions = {}): Command => {
  const { app, commands, configure, firstScreen } = definition
  const program = new Command()
  const mounted = commands()
  const messenger = app.messenger !== false
  const found = messenger ? "found messages" : "found items"
  const content = messenger ? "message content" : "content"
  const sample = messenger ? "chats list" : sampleCommand(mounted)
  // A CLI where every command is profile-free has nothing to show a profile with, so it says nothing about one.
  const profileHelp = sample
    ? `\n\nThe first word is the profile whenever it is not a command — \`${app.command} personal ${sample}\`.\n` +
      `\`${app.envPrefix}_PROFILE\` says the same thing for a whole shell session.\n` +
      "No profile is assumed: without one, a command that uses an account stops and lists the profiles here."
    : ""

  program
    .name(app.command)
    .usage("[profile] [options] <command>")
    .description(`${app.description}${profileHelp}`)
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
    .option("--trace", `the connection's own log lines on stderr — never ${content}`)
    .option("--debug", "on a failure, its whole record — cause and stack — in place of the short line")
    .option("--timeout <duration>", "give up on the whole command after this — 30s, 2m, 500ms")
    .option("--offline", "answer from what was recorded and never connect; fails if nothing was")
    .option("--no-input", "never prompt or open interactive login; piped input remains available")
    .option("--max-input-bytes <bytes>", "maximum buffered input bytes (default: 16777216)")
    .option("--max-output-bytes <bytes>", "maximum machine output bytes (default: 4194304; 0 disables)")
    .option("--brief", `${found} as reference, title, time, ${messenger ? "sender" : "author"} and excerpt only`)
    .option("--full", `${found} with their whole text and every provider field`)
    .option(
      COMPACT_FLAG,
      "one line per item for an agent: reference first, text last, paging and next steps as # lines",
    )
    .option("--dry-run", "preview parsed arguments and permissions before running the action")
    .option("--yes", "go ahead without the question an ask level puts before a write")
    .option(
      "--record",
      "keep this run even where the config says record false; record_input false leaves the typed words out",
    )
    .option("--no-record", "do not keep this run, even if it fails")
    .showHelpAfterError()

  for (const command of mounted) program.addCommand(command)
  configure?.(program)
  if (!contractsChecked.has(definition)) {
    if (definition.rows) entityRows(definition.rows)
    assertSharedContracts(program)
    contractsChecked.add(definition)
  }
  installHelp(program, { pitch: app.description, ...firstScreen })

  // Commander builds a usage line from the command tree, where the profile is not a word.
  if (firstScreen?.profile !== false)
    for (const top of program.commands)
      forEachCommand(top, (command) =>
        command.configureHelp({
          ...command.configureHelp(),
          commandUsage: (shown) => {
            const usage = new Help().commandUsage(shown)
            return takesProfile(shown) ? `${app.command} <profile>${usage.slice(app.command.length)}` : usage
          },
        }),
      )

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

/** The command ran in serve, which printed its answer here; `run()` returns its exit code. */
class Relayed extends Error {
  constructor(readonly code: number) {
    super("relayed")
  }
}

/**
 * An interactive command run without a terminal — an agent's `session start qr` — waits on a person scanning a
 * code somewhere else, which 30 s does not cover.
 */
export const HEADLESS_INTERACTIVE_MS = 5 * 60_000

/** How much longer than the command's own deadline a client waits for serve to say how it ended. */
const RELAY_MARGIN_MS = 10_000

/**
 * Runs the program and **returns an exit code instead of throwing**. A stack trace is not an error
 * message: it tells a script nothing it can branch on, and exits 1 for every kind of failure alike.
 */
export const run = async (argv: string[], definition: ProgramDefinition, options: RunOptions = {}): Promise<number> => {
  const outer = processRun()
  try {
    return await runOnce(argv, definition, options)
  } finally {
    useAsProcessRun(outer)
  }
}

const runOnce = async (argv: string[], definition: ProgramDefinition, options: RunOptions): Promise<number> => {
  const streams = options.streams ?? processStreams
  if (!options.streams) quietBrokenPipes()
  const delimiter = argv.indexOf("--")
  const flags = argv.slice(0, delimiter < 0 ? undefined : delimiter)
  const machine = flags.some(
    (word) => word === "--json" || word.startsWith("--json=") || word === "--jsonl" || word === COMPACT_FLAG,
  )
  const debug = flags.includes("--debug")
  const reporting = machine ? { ...options, tty: false } : options
  const control = execution(streams, { maxOutputBytes: 0 })
  let restoreInput: (() => void) | undefined
  let signalExit: number | undefined
  // Ctrl-C or `kill` is how a command that listens until stopped ends: still aborted, but exit 0.
  let listens = false
  // After untilStopped(), a signal or a cancel ends only that phase; the command finishes and says how it went.
  let phase = new AbortController()
  let phased = false
  let phaseTimer: NodeJS.Timeout | undefined
  // The deadline a person or a script set, which a phase keeps; the default one it ends.
  let explicitEnd: number | undefined
  let oneShot: number | undefined
  // Headless, an interactive command's 5 minutes are for its phase; a person at a terminal may still be answering.
  let afterPhase: number | undefined
  let running: { endsAt: number; ms: number } | undefined
  const startDeadline = (ms: number | undefined) => {
    running = ms === undefined ? undefined : { endsAt: Date.now() + ms, ms }
    control.start(ms)
  }
  let finished = false
  // The steps after a phase are one-shot again, however it ended: bounded, and ended by a signal as any command is.
  const endPhase = () => {
    if (!phased) return
    phased = false
    if (phaseTimer) clearTimeout(phaseTimer)
    // A later phase keeps the --timeout the steps after this one got, not the one this phase already used up.
    if (explicitEnd !== undefined && oneShot !== undefined) explicitEnd = Date.now() + oneShot
    startDeadline(afterPhase)
  }
  const interrupted = (signal: "SIGINT" | "SIGTERM") => {
    // A second signal ends the command as any signal does: one that ignores its phase can still be stopped.
    if (phased && !phase.signal.aborted)
      return phase.abort(new CliError("cancelled", `stopped by ${signal}`, { reason: signal, retryable: false }))
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
  const externalAbort = () => {
    const cancelled = new CliError("cancelled", "command cancelled", { retryable: false })
    if (phased) phase.abort(cancelled)
    else control.abort(cancelled)
  }
  const { command } = definition.app
  // Commander's own error lines are replaced by ours; its help for a missing subcommand is kept for a person.
  let help = ""
  const program = createProgram(definition, {
    out: (text) => control.streams.data(text.replace(/\n$/, "")),
    err: (text) => {
      help += text
    },
  })
  const exit: { code?: number } = {}
  const environment: RunOptions = {
    ...options,
    argv,
    streams: control.streams,
    signal: options.signal ? AbortSignal.any([control.signal, options.signal]) : control.signal,
    commandSignal: control.signal,
    trackCloseable: control.trackCloseable,
    app: definition.app,
    ...(definition.rows ? { rows: definition.rows } : {}),
    platform: options.platform ?? process.platform,
    exit,
    runCommand: (words, given) => run(words, definition, given as RunOptions),
    discoveryAvailability: (info) => {
      const inspected = info.path.reduce<Command | undefined>(
        (parent, word) => parent?.commands.find((one) => one.name() === word),
        program,
      )
      const flags = (inspected ?? program).optsWithGlobals<GlobalFlags & { bot?: boolean }>()
      const env = options.env ?? process.env
      if (!flags.profile && !env[envName(definition.app, "PROFILE")]) return undefined
      try {
        const overrides = options.agent?.overrides ?? []
        const settings = (definition.configuration ?? settingsFor(definition.app)).resolveSettings(
          overrides.length ? { ...flags, permission: [...overrides, ...(flags.permission ?? [])] } : flags,
          {
            env,
            needsProfile: false,
            kind: info.path[0] === "bot" || flags.bot ? "bot" : "personal",
          },
        )
        if (!settings.permissions) return undefined
        return commandAvailability(
          info,
          settings.permissions,
          definition.configuration?.permissionKey ?? definition.configuration?.permissions?.keyOf,
          changesAuthorityAt(program),
          readOnlyLockOf(definition.app, env) !== undefined,
          options.agent !== undefined,
          definition.configuration?.permissions,
        )
      } catch {
        // Help must still work when the configuration needs repair.
        return undefined
      }
    },
    untilStopped: () => {
      if (phased || finished) return phase.signal
      phased = true
      phase = new AbortController()
      phase.signal.addEventListener("abort", endPhase, { once: true })
      startDeadline(undefined)
      if (explicitEnd !== undefined)
        phaseTimer = setTimeout(
          () =>
            phase.abort(
              new CliError("timeout", "the command reached its --timeout", {
                retryable: false,
                reason: "command.timed-out",
              }),
            ),
          Math.max(0, explicitEnd - Date.now()),
        )
      return phase.signal
    },
    endUntilStopped: endPhase,
    deadline: () => running,
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
    const argvLog = commandEnv[envName(definition.app, "TEST_ARGV_LOG")]
    if (argvLog) logParsedArgv(argvLog, action)
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
    const input = options.stdin ?? process.stdin
    // The first-run questions write the shared config; a dry run writes nothing.
    if (!flags.dryRun)
      await setupAtStart({
        command,
        env: commandEnv,
        contentLanguages: definition.app.contentLanguages,
        path,
        headless,
        readOnlyLock: lock,
        input,
        terminal: !options.streams && input.isTTY === true && process.stderr.isTTY === true,
      })
    if (lock && isLogin(action) && !flags.dryRun) throw readOnlyRefusal(lock, "log in or out")
    if (lock && isStoreChange(action) && !flags.dryRun) throw readOnlyRefusal(lock, storeChangeRefusal(definition.app))
    refuseWriteBeforeConnecting(action, {
      app: definition.app,
      env: commandEnv,
      dryRun: flags.dryRun === true,
      ...(definition.configuration ? { resolve: definition.configuration.resolveSettings } : {}),
    })
    if (definition.configuration?.permissions)
      refuseByCommandPermissions(action, definition.configuration.permissions, {
        app: definition.app,
        env: commandEnv,
        dryRun: flags.dryRun === true,
        resolve: definition.configuration.resolveSettings,
      })
    // A client older than the relay's refusal to forward a login still sends one; on serve it would log out serve.
    if (options.relayed && isLogin(action))
      throw new CliError(
        "permission_error",
        `\`${command} ${path.join(" ")}\` logs the account in or out, which serve never runs for a client — stop ` +
          `serve first (\`${command} ${options.relayed.profile} server stop\`), or update ${command}, which then runs it here`,
        { sent: false },
      )
    if (lock && changesAuthorityNow(action) && !flags.dryRun)
      throw new CliError(
        "permission_error",
        `this process is read-only (${lock}) — \`${command} ${path.join(" ")}\` changes what a later run may do; ` +
          `run it without ${lock}`,
      )
    if (options.agent && options.agent.authority !== true && changesAuthorityNow(action))
      throw new CliError(
        "permission_error",
        `\`${command} ${path.join(" ")}\` changes what a later run may do, and this profile keeps that from agents ` +
          `(${AUTHORITY_KEY}) — the owner turns it on in a terminal: ` +
          `\`${command} <profile> config set${path[0] === "bot" ? " --bot" : ""} permissions.${AUTHORITY_KEY} allow\``,
        { permission: AUTHORITY_KEY, sent: false },
      )
    if (options.agent && options.agent.botApi !== true && isBotApi(path))
      throw new CliError(
        "permission_error",
        `\`${command} ${path.join(" ")}\` calls the Bot API directly, past the send guard and the recipient list, ` +
          `and this profile keeps that from agents (${BOT_API_KEY}) — the owner turns it on in a terminal: ` +
          `\`${command} <profile> config set --bot permissions.${BOT_API_KEY} allow\``,
        { permission: BOT_API_KEY, sent: false },
      )
    const { lifetime, cooperative: stopsAtItsPace, partial: answersPartial } = metaOf(action)
    const persistent = lifetime === "persistent"
    listens = persistent
    const interactiveLogin = !headless && lifetime === "interactive"
    const timeout = flags.timeout ?? (commandEnv[envName(definition.app, "TIMEOUT")]?.trim() || undefined)
    // A background fetch was asked to outlive the shell; only an explicit --timeout bounds it.
    const job = commandEnv[envName(definition.app, "BACKFILL_JOB")] !== undefined
    const deadline =
      timeout === undefined
        ? persistent || interactiveLogin || job
          ? undefined
          : lifetime === "interactive"
            ? HEADLESS_INTERACTIVE_MS
            : stopsAtItsPace === true
              ? options.agent
                ? DEFAULT_AGENT_COOPERATIVE_MS
                : answersPartial === true
                  ? DEFAULT_SYNC_MS
                  : DEFAULT_COOPERATIVE_MS
              : DEFAULT_COMMAND_MS
        : persistent
          ? undefined
          : parseDuration(timeout, flags.timeout === undefined ? envName(definition.app, "TIMEOUT") : "--timeout")
    // serve's relay ends its runs by their signal; a handler each would also end serve's own work.
    if (!options.relayed) process.on("SIGINT", sigint).on("SIGTERM", sigterm)
    const target =
      options.relayed || options.agent || flags.dryRun
        ? undefined
        : relayTarget(
            definition.app,
            action,
            flags as { offline?: boolean; http?: boolean },
            () =>
              (definition.configuration ?? settingsFor(definition.app)).resolveSettings(flags, {
                env: commandEnv,
                needsProfile: false,
                readOnly: true,
              }).profile,
            commandEnv,
          )
    if (!options.streams) {
      process.stdout.on("error", pipeError)
      process.stderr.on("error", pipeError)
    }
    if (target) {
      const served = target.lock.version
      if (served !== undefined && served !== definition.app.version && !flags.quiet)
        streams.diagnostic(
          `${command} ${target.profile} serve runs ${served}, this is ${definition.app.version} — the command runs as ` +
            `${served} does until serve restarts`,
        )
      const input = options.stdin ?? process.stdin
      const code = await relayCommand(
        target.lock.relay.path,
        {
          argv,
          env: Object.fromEntries(
            Object.entries(commandEnv).filter((entry): entry is [string, string] => entry[1] !== undefined),
          ),
          cwd: process.cwd(),
          tty: options.tty ?? process.stdout.isTTY === true,
          stdinTty: input.isTTY === true,
        },
        {
          streams,
          stdin: input,
          stdout: options.stdout ?? process.stdout,
          signal: environment.signal as AbortSignal,
          listens: persistent,
          ...(deadline === undefined ? {} : { deadlineMs: deadline + RELAY_MARGIN_MS }),
          writes: metaOf(action).effects?.remote !== "read",
          holder: `${command} ${target.profile} serve (PID ${target.lock.pid})`,
        },
      )
      throw new Relayed(code)
    }
    startDeadline(deadline)
    oneShot = deadline
    afterPhase = timeout !== undefined || persistent || job || interactiveLogin ? deadline : DEFAULT_COMMAND_MS
    if (timeout !== undefined && deadline !== undefined) explicitEnd = Date.now() + deadline
    // An agent's run shares this process's directory; a chat folder's name is not a path to resolve.
    if (options.relayed && !options.agent) absolutePaths(action, options.relayed.cwd)
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
        // No permission governs housekeeping like `skill install`, so no profile's settings change its preview.
        needsProfile: keyForCommand(path) !== null,
      })
      const previewed = preview(
        action,
        {
          permissions: resolved.permissions ?? {},
          permissionSources: resolved.permissionSources ?? {},
          configPath: resolved.configPath ?? "",
          profile: resolved.profile,
          ...(resolved.savedPermissions ? { savedPermissions: resolved.savedPermissions } : {}),
        },
        command,
        definition.configuration?.permissionKey ?? definition.configuration?.permissions,
        definition.app.messenger !== false,
      )
      renderAnswer(action, outputFor(action), itemOf(snakeKeys(previewed)))
      throw new PreviewComplete()
    }
    // Not inside the scheduled run itself: its own failure is already on its way to last.json.
    if (!flags.quiet && commandEnv[envName(definition.app, "SCHEDULED")] === undefined && path[0] !== "schedule") {
      const notice = failingNoticeFor(definition.app, commandEnv, program)
      if (notice) streams.diagnostic(notice)
    }
    await definition.prepare?.(program, environment)
    if (control.signal.aborted) throw control.failure()
  })
  // Depth-first: a subcommand left with the default behaviour kills the process from inside a test.
  forEachCommand(program, (child) => child.exitOverride())

  // Before commander, not inside it: commander has no hook that runs before it decides which
  // subcommand it is looking at.
  const { profile, rest: lifted } = liftProfile(argv, commandWords(program), valuedOptions(program))
  // `wa 'chats list' --help` reads "chats list" as a profile and prints the root help with exit 0.
  try {
    // Only before `--`: what follows is a positional, an agent's text among them, never a command word.
    const end = lifted.indexOf("--")
    for (const words of [flags, end < 0 ? lifted : lifted.slice(0, end)])
      refuseJoinedPath(
        program,
        words.filter((word) => !word.startsWith("-")),
        profile !== undefined && !/\s/.test(profile) ? [profile] : [],
      )
  } catch (failure) {
    const settled = await settleFailure(failure, { definition, program, rest: lifted, argv, profile, options })
    return report(streams, reporting, failed(definition, program, lifted, failure, settled, debug))
  }
  if (profile !== undefined) program.setOptionValue("profile", profile)
  const requested = liftJson(lifted, (words) => commandAt(program, commandPath(program, words)))
  const rest = requested.argv
  if (requested.fields !== undefined) program.setOptionValue("fields", requested.fields)

  // A bare word with nothing after it would make commander print help **on stdout**, which breaks
  // the one contract this program has and says nothing about why.
  if (profile !== undefined && rest.length === 0) {
    const asProfile =
      commandAt(program, "account show") && isProfileName(profile)
        ? `, or \`${command} ${profile} account show\` if "${profile}" is your profile`
        : ""
    const message =
      `"${profile}" is not a command, so it was read as a profile name — and no command followed it. ` +
      `Run \`${command} --help\` for the commands${asProfile}.`
    const failure = new CliError("validation_error", message, { param: "profile" })
    const settled = await settleFailure(failure, { definition, program, rest, argv, profile, options })
    return report(streams, reporting, failed(definition, program, rest, failure, settled, debug))
  }

  try {
    await control.race(() => program.parseAsync(rest, { from: "user" }))
    const code = exit.code ?? (process.exitCode === undefined ? 0 : Number(process.exitCode))
    const refreshed = code === 0 ? refreshFor(definition, program, rest, options) : undefined
    if (refreshed && !rest.includes("--quiet")) streams.diagnostic(refreshed)
    const hint =
      code === 0 && rest[0] !== "commands" && rest[0] !== "help" && !rest.includes("--quiet")
        ? hintFor(definition, rest, options)
        : undefined
    if (hint) streams.diagnostic(hint)
    return code
  } catch (caught) {
    if (caught instanceof Relayed) return caught.code
    const error = control.failure() ?? caught
    if (error instanceof PreviewComplete) return 0
    if (signalExit === 0) return 0
    if (isCommanderFailure(error)) {
      const argvLog = (options.env ?? process.env)[envName(definition.app, "TEST_ARGV_LOG")]
      // --version ends before any action, so the preAction hook never logs it.
      if (argvLog && error.code === "commander.version") logVersion(argvLog)
      if (error.exitCode === 0) return 0
      // Commander puts its "(Did you mean …?)" on a line of its own; an error is one line.
      let message = error.message.replace(/^error: /, "").replace(/\s*\n\s*/g, " ")
      if (error.code === "commander.help") {
        if (reporting.tty ?? process.stdout.isTTY === true) {
          streams.diagnostic(help.replace(/\n$/, ""))
          return exitCodeFor("validation_error")
        }
        const group = commandPath(program, rest)
        message = `give a command — run \`${[command, group, "--help"].filter(Boolean).join(" ")}\` for the commands`
      }
      if (
        profile !== undefined &&
        error.code === "commander.unknownCommand" &&
        rest[0] !== undefined &&
        !commandWords(program).has(rest[0])
      ) {
        message = message.trimEnd()
        message += ` — "${profile}" is not a command, so it was read as a profile name — which left "${rest[0]}" to be one.`
      }
      const failure = new CliError("validation_error", message)
      const settled = await settleFailure(failure, { definition, program, rest, argv, profile, options })
      return report(streams, reporting, failed(definition, program, rest, failure, settled, debug))
    }
    const settled = await settleFailure(error, { definition, program, rest, argv, profile, options })
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
    finished = true
    if (phaseTimer) clearTimeout(phaseTimer)
    await control.finish()
  }
}

let pipesQuiet = false

/**
 * A reader that stopped reading (`| head`) is not an error, during the run or after it, when what was written is
 * still flushing: without a listener Node prints a stack trace over the output that worked.
 */
const quietBrokenPipes = () => {
  if (pipesQuiet) return
  pipesQuiet = true
  for (const stream of [process.stdout, process.stderr])
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error
    })
}

const failingNoticeFor = (app: AppIdentity, env: NodeJS.ProcessEnv, program: Command) => {
  try {
    const state = resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state
    return failingNotice(app.command, scheduledRuns(state), lineOf(program, "schedule list"))
  } catch {
    return undefined
  }
}

const NO_REFRESH_COMMANDS = ["skill", "complete", "commands", "help"]

/** Not while `skill` runs: right after an update, `skill status` must report the copies as they are. */
const refreshFor = ({ app }: ProgramDefinition, program: Command, argv: string[], options: RunOptions) => {
  const env = options.env ?? process.env
  try {
    if (NO_REFRESH_COMMANDS.includes(argv[0] ?? "") || skipsSkillRefresh(app, env)) return undefined
    const skill = skillSourceOf(program, app.appName)
    if (!skill) return undefined
    const state = resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state
    return refreshSkills({ app, skill, env, markerPath: join(state, "skill-refresh.json") })
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
  /** As given, the profile word included: what the run keeps, masked. */
  argv: string[]
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
 * Its words are kept as `record_input` says (`maskArgv`); a configuration that did not load masks them, since it may
 * be the one that turned recording input off.
 */
const keepFailure = async (
  failure: unknown,
  { definition, program, rest, argv, profile, options }: Failed,
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
  const command = `${options.agent ? "mcp " : ""}${path || definition.app.command}`
  await recorded(
    {
      app: definition.app,
      command,
      context: runContextOf({
        bin: definition.app.command,
        command: path ? command : options.agent ? "mcp" : "",
        program,
        argv,
        env,
        recordInput: settings ? (settings.recordInput ?? true) : false,
        caller: options.agent?.caller,
      }),
      // Settings that did not load never accepted the word, which may be a refused name or somebody's words.
      profile: settings ? namedProfile(settings) : undefined,
      record: false,
      keepFailed: settings?.keepFailedRuns ?? !rest.includes("--no-record"),
      trace: false,
      format: "json",
      streams: options.streams ?? processStreams,
      env,
      ...(settings ? { keepDays: settings.keepRunsForDays } : {}),
      ...(settings?.keepSuccessfulRunsForDays === undefined
        ? {}
        : { keepSuccessDays: settings.keepSuccessfulRunsForDays }),
    },
    async () => {
      throw failure
    },
  ).catch(() => {})
}

/** Mounted, or reached through a command that takes no subcommand, where the rest of the path is its argument. */
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
  program: Command
}

const failed = (
  { app }: ProgramDefinition,
  program: Command,
  rest: string[],
  error: unknown,
  settled: { settlementFailed?: true },
  debug: boolean,
): Failure => {
  const path = commandPath(program, program.args.length > 0 ? program.args : rest)
  const told = error instanceof NoProfileHere && !commandAt(program, "setup") ? error.withoutSetup(path) : error
  const failure =
    settled.settlementFailed && isCliFailure(told)
      ? new CliError(told.code, told.message, { ...told.details, settlement_failed: true })
      : told
  const effects = judgedEffects(path ? metaOf(commandAt(program, path) ?? program).effects : undefined)
  const built = errorObjectOf(failure, {
    ...failureContext(app.errors),
    targets: judgedTargets(program),
    ...(effects ? { effects } : {}),
  })
  const { next: _named, ...said } = built.error
  const steps = failureSteps(program, built.error)
  const object: typeof built = { ...built, error: { ...said, ...(steps.length > 0 ? { next: steps } : {}) } }
  showInputFields(object, (path && commandAt(program, path)) || program)
  const command = path || app.command
  return {
    object,
    cli: app.command,
    program,
    ...(debug
      ? { record: errorRecordOf(failure, object, { command, service: app.command, version: app.version }) }
      : {}),
  }
}

/**
 * **A failure never reaches stdout.** It goes to stderr — as JSON when nobody is watching, because
 * an exit code says which kind of thing went wrong and nothing about which chat or how long to wait.
 */
const report = (streams: Streams, options: BaseEnvironment, { object, record, cli, program }: Failure): number => {
  if (options.agent) {
    options.agent.failure(object)
    return exitCodeOfError(object)
  }
  const interactive = options.tty ?? process.stdout.isTTY === true
  const lined = object.error.next ? { error: { ...object.error, next: withLines(program, object.error.next) } } : object
  streams.diagnostic(renderError(lined, { cli, interactive, ...(record ? { record } : {}) }))
  return exitCodeOfError(lined)
}
