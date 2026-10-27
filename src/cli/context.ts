import { CliError, type KeyringStore, type Renderer, type RenderFormat, type Streams } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import type { ErrorObject } from "@wirecat/cli-base/standards"
import type { Command } from "commander"
import { type Deadline, type RunBudget, runBudget } from "../background/budget.js"
import type { MessageEvent } from "../domain/models.js"
import { resolveOutput } from "../output.js"
import type { AppIdentity } from "../ports/app.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import type { EventSink } from "../runs/events.js"
import { recorded } from "../runs/recording.js"
import { currentCaller, keepsSuccess, type RunCaller, runContextOf } from "../runs/run-context.js"
import type { OpenRecognizer } from "../speech/transcribe.js"
import type { SecretInput } from "../terminal/prompt.js"
import { type Closeable, withDeadline } from "./deadline.js"
import { withAbort } from "./execution.js"
import { rootOf } from "./profile.js"
import { type GlobalFlags, namedProfile, type ResolveOptions, type Settings } from "./settings.js"

/** What every CLI's commands write to, when it is not the real terminal. A CLI adds its own fields. */
export interface BaseEnvironment {
  discoveryAvailability?: (
    command: import("./command-availability.js").AvailabilityCommand,
  ) => import("./command-availability.js").CommandAvailability | undefined
  streams?: Streams
  /** Whether a person is looking. Defaults to whether stdout is a terminal. */
  tty?: boolean
  env?: NodeJS.ProcessEnv
  /** The OS keyring in place of the real one; every test hands in `memoryKeyring()`. */
  keyring?: KeyringStore
  /** Ends a long-running command — `watch` — in place of Ctrl-C; tests hand one in. */
  commandSignal?: AbortSignal
  signal?: AbortSignal
  trackCloseable?: (closeable: Closeable) => void
  /** Where a command reads text it was not given as an argument. */
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean }
  /** The owner's answer to a question, or `null` with nobody at a terminal; tests hand one in. */
  answer?: (question: string) => Promise<string | null> | string | null
  /** Set by `run()`; a command's run is recorded only when it is known whose run it is. */
  app?: AppIdentity
  /** Set by `run()` from `process.platform` unless a test hands one in: the OS a command's paths and units are for. */
  platform?: NodeJS.Platform
  /** The local speech recognizer in place of the downloaded model; tests hand one in. */
  recognizer?: OpenRecognizer
  /** How long `store restore` and `store reset` wait on another connection's write, 1 s unless a test hands one in. */
  storeLockWaitMs?: number
  /** How long a connection's close waits on its saves and passive listens, 5 s unless a test hands one in. */
  closeWaitMs?: number
  /** How long one pass of chat re-keys holds the store's write lock and the pause after it; tests hand in no pause. */
  rekeyPacing?: { lockMs: number; pauseMs: number }
  /** Where raw bytes go when stdout is not this process's own — an MCP session relayed by serve. */
  stdout?: NodeJS.WritableStream
  /** Where a prompt and what is typed at it go, in place of the process's stderr; tests hand one in. */
  stderr?: NodeJS.WritableStream
  /** Set by `run()`: this run's exit code, so two runs in one process (serve's relay) do not share one. */
  exit?: { code?: number }
  /** Set by `run()`: the same program again, for serve to run a client's command. */
  runCommand?: (argv: string[], environment: BaseEnvironment) => Promise<number>
  /** Set by serve on a command it runs for a client through its relay. */
  relayed?: RelayedRun
  /**
   * A test's hook into `serve`: called with each event once its reply and task rules have run — to wait on "the
   * message was handled, and nothing was sent" instead of on the next event or a sleep.
   */
  handled?: (event: MessageEvent) => void
  /** Set by an MCP server on a command it runs for an agent (`runCommandForAgent`). */
  agent?: AgentRun
  /** Set by `run()`: the words it was given, which a run keeps as `record_input` says (`maskArgv`). */
  argv?: readonly string[]
  /**
   * Set by `run()`: the rest of the command has no default deadline, and Ctrl-C, SIGTERM, a cancel or an explicit
   * `--timeout` aborts the signal it returns instead of the command, which then ends as it says — exit 0 with what it
   * got. A second signal ends the command. For a phase that keeps
   * what each step brings and may stop at any point: the history a phone pushes after linking.
   */
  untilStopped?: () => AbortSignal
  /** Set by `run()`: the deadline running now, or none (a persistent command, a phase, a background job). */
  deadline?: () => Deadline | undefined
  /**
   * Set by `run()`: ends the phase `untilStopped()` began without aborting its signal — the command saw it finish.
   * However a phase ends, the steps after it get the command's one-shot deadline again, started afresh, and a signal
   * or a cancel ends the command once more. Without `--timeout` a headless interactive command gets the default 30 s,
   * not its 5 minutes; at a terminal it stays unbounded, since a later step may still ask the person (WC-LIFE-5).
   */
  endUntilStopped?: () => void
}

/**
 * The command's answer and error go to the MCP server as objects, never as text. A write at level `ask` goes
 * ahead (NEED-773): nobody is at a terminal, and the profile's permissions already decided.
 */
export interface AgentRun {
  result: (value: unknown) => void
  failure: (error: ErrorObject) => void
  /** The server's own stricter levels, `key=level`, as `mcp --permission` takes them; they never loosen. */
  overrides?: readonly string[]
  /** The server's levels allow `mcp.authority`: a command that changes what a later run may do may run. */
  authority?: boolean
  /** The server's levels allow `bot.api`: a raw Bot API call, past the send guard, may run. */
  botApi?: boolean
  /** Who made the MCP call, as the server received it; the run records it instead of the server's environment. */
  caller?: RunCaller
}

export interface RelayedRun {
  /** The profile serve holds; a command for another is refused before it touches the connection. */
  profile: string
  /** The client's working directory, which its relative paths mean. */
  cwd: string
  /** A promise when the lender opens it on first use. */
  connection: () => MessengerAdapter | Promise<MessengerAdapter>
}

/**
 * A budget for a resumable sync, from the deadline running now and the CLI's `requestMs`: so a lower `--timeout`
 * means fewer requests. `requests` (`--max-pages`) can only lower it.
 */
export const runBudgetOf = (command: Command, requests?: number): RunBudget => {
  const { deadline, signal, app } = environmentOf(command)
  const now = deadline?.()
  return runBudget({
    ...(requests === undefined ? {} : { requests }),
    ...(app?.requestMs === undefined ? {} : { requestMs: app.requestMs }),
    ...(now ? { deadline: now } : {}),
    ...(signal ? { signal } : {}),
  })
}

/** A partial answer's exit code, for this run alone. */
export const setExitCode = (command: Command, code: number): void => {
  const slot = environmentOf(command).exit
  if (slot) slot.code = code
  else process.exitCode = code
}

const environments = new WeakMap<Command, BaseEnvironment>()

export const provide = (program: Command, environment: BaseEnvironment): void => {
  environments.set(program, environment)
}

export const environmentOf = <E extends BaseEnvironment = BaseEnvironment>(command: Command): E =>
  (environments.get(rootOf(command)) ?? {}) as E

/**
 * The input and output `readSecret` uses for this command: the run's own, so a prompt goes where the run's other
 * output goes and a test that captures it sees it. `readSecret(prompt, { ...secretInputOf(this), echo: true })`.
 */
export const secretInputOf = (command: Command): Pick<SecretInput, "input" | "output"> => {
  const { stdin, stderr } = environmentOf(command)
  return { ...(stdin ? { input: stdin } : {}), ...(stderr ? { output: stderr } : {}) }
}

/** For the commands that print but never need settings or a connection. */
export const outputFor = (command: Command) => {
  const { streams, tty, env, agent } = environmentOf(command)
  return resolveOutput({
    ...command.optsWithGlobals(),
    ...(agent ? { capture: agent.result } : {}),
    ...(streams ? { streams } : {}),
    ...(env ? { env } : {}),
    ...(tty === undefined ? {} : { tty }),
  })
}

export interface BaseContext {
  settings: Settings
  renderer: Renderer
  format: RenderFormat
  /** Whether the human view may use colour — for views that print their own text. */
  color: boolean
  streams: Streams
  env: NodeJS.ProcessEnv
  keyring?: KeyringStore
  /**
   * Runs the body inside `--timeout`, closing whatever was tracked when it expires, and records it
   * when `--record` asks or it fails. Whatever holds the process open — a connection — must be
   * tracked **before** it can block, or a timed-out command reports the timeout and then hangs.
   */
  /**
   * `unbounded` is for a command that ends itself at `--timeout` — `watch` — rather than failing there.
   * `name` names the run when one command runs many — each MCP tool call is its own run.
   */
  run: <T>(body: (events: EventSink) => Promise<T>, options?: { unbounded?: boolean; name?: string }) => Promise<T>
  track: (closeable: Closeable) => void
}

type Resolve = (flags: GlobalFlags, options?: ResolveOptions) => Settings

const detailOf = ({ brief, full }: { brief?: boolean; full?: boolean }): { hitDetail?: "brief" | "full" } => {
  if (brief && full) throw new CliError("validation_error", "--brief and --full ask for opposite things — pick one")
  return brief ? { hitDetail: "brief" } : full ? { hitDetail: "full" } : {}
}

/** Everything a command needs that no messenger decides, resolved once. */
export const baseContext = (command: Command, resolveSettings: Resolve): BaseContext => {
  const environment = environmentOf(command)
  const env = environment.env ?? process.env
  const flags = command.optsWithGlobals<GlobalFlags>()
  const overrides = environment.agent?.overrides ?? []
  const settings = resolveSettings(
    overrides.length > 0 ? { ...flags, permission: [...overrides, ...(flags.permission ?? [])] } : flags,
    { env },
  )
  const { renderer, format, color, streams } = resolveOutput({
    ...settings,
    env,
    ...detailOf(command.optsWithGlobals<{ brief?: boolean; full?: boolean }>()),
    ...(command.optsWithGlobals<{ fields?: string }>().fields
      ? { fields: command.optsWithGlobals<{ fields?: string }>().fields }
      : {}),
    ...(environment.agent ? { capture: environment.agent.result } : {}),
    ...(environment.streams ? { streams: environment.streams } : {}),
    ...(environment.tty === undefined ? {} : { tty: environment.tty }),
  })
  const closeables: Closeable[] = []
  const ranFor = namedProfile(settings)

  return {
    settings,
    renderer,
    format,
    color,
    streams,
    env,
    ...(environment.keyring ? { keyring: environment.keyring } : {}),
    // The deadline inside the record, so a timeout finishes the run as failed rather than leaving it running.
    run: (body, { unbounded = false, name } = {}) => {
      if (!environment.app)
        return withAbort(environment.commandSignal, () =>
          withDeadline(unbounded ? undefined : settings.commandTimeoutMs, closeables, () => body(() => {})),
        )
      // An agent's run is named `mcp <command>`, so `search runs` and `sends list` tell it from the owner's.
      const runName = name ?? `${environment.agent ? "mcp " : ""}${commandPath(command)}`
      return recorded(
        {
          app: environment.app,
          command: runName,
          context: runContextOf({
            bin: environment.app.command,
            command: runName,
            program: rootOf(command),
            ...(environment.argv ? { argv: environment.argv } : {}),
            env,
            recordInput: settings.recordInput ?? true,
            caller: environment.agent?.caller ?? currentCaller(),
          }),
          ...(ranFor === undefined ? {} : { profile: ranFor }),
          record: keepsSuccess({
            record: settings.record,
            fromFlag: settings.sources?.record === "flag",
            env,
            caller: environment.agent?.caller ?? currentCaller(),
            persistent: metaOf(command).lifetime === "persistent",
          }),
          keepFailed: settings.keepFailedRuns,
          trace: settings.trace,
          keepDays: settings.keepRunsForDays,
          ...(settings.keepSuccessfulRunsForDays === undefined
            ? {}
            : { keepSuccessDays: settings.keepSuccessfulRunsForDays }),
          ...(settings.runsSizeLimitMb === undefined ? {} : { maxBytes: settings.runsSizeLimitMb * 1024 * 1024 }),
          processRun: !environment.agent,
          format,
          streams,
          env,
        },
        (events) =>
          withAbort(environment.commandSignal, () =>
            withDeadline(unbounded ? undefined : settings.commandTimeoutMs, closeables, () => body(events)),
          ),
      )
    },
    track: (closeable) => {
      closeables.push(closeable)
      environment.trackCloseable?.(closeable)
    },
  }
}

/** `messages send` — the words that name commands, never the arguments: those can be a message. */
const commandPath = (command: Command): string => {
  const words: string[] = []
  for (let current: Command | null = command; current?.parent; current = current.parent) words.unshift(current.name())
  return words.join(" ")
}
