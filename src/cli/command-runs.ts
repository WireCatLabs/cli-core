import { AsyncLocalStorage } from "node:async_hooks"
import { isCliError, type RenderFormat, type Streams } from "@wirecat/cli-base"
import type { Command } from "commander"
import type { AppIdentity } from "../ports/app.js"
import type { RequestEvent } from "../runs/events.js"
import { type Recording, startRecording, wasSettled } from "../runs/recording.js"
import { KEEP_RUNS_FOR_DAYS } from "../runs/run.js"
import { runContextOf } from "../runs/run-context.js"
import { environmentOf } from "./context.js"
import { rootOf } from "./profile.js"

/** What the owner saved: `record` and `keep_runs_for_days`, read from the CLI's own config. */
export interface SavedRunSettings {
  record?: boolean | undefined
  keepRunsForDays?: number | undefined
  /** `record_input`: left out, the typed words are kept, secrets hidden. */
  recordInput?: boolean | undefined
}

export interface RunSettings {
  record: boolean
  keepFailedRuns: boolean
  keepRunsForDays: number
}

/** `--record`/`--no-record` first, then the config; a failure is kept unless either says no (WC-LIFE-15). */
export const runSettings = (flag: boolean | undefined, saved: SavedRunSettings = {}): RunSettings => {
  const record = flag ?? saved.record ?? false
  return {
    record,
    keepFailedRuns: record || (flag !== false && saved.record !== false),
    keepRunsForDays: saved.keepRunsForDays ?? KEEP_RUNS_FOR_DAYS,
  }
}

export interface CommandRunOptions {
  app: AppIdentity
  /**
   * The owner's saved choice. One that throws — a config that will not load — leaves the defaults, except that the
   * typed words are masked: the broken config may be the one that says `record_input: false`.
   */
  settings: () => SavedRunSettings
  /**
   * The profile the command runs for; one that throws or is empty leaves the run without one. Given only by a CLI
   * whose first word may be a profile, so a failure before any command skips that word when naming the run.
   */
  profile?: () => string | undefined
  /** An agent's run is named `mcp <command>`. Read from the program's environment when left out. */
  agent?: boolean
  /** The data stream's format, which the warning about an unwritable run follows; `--json`/`--jsonl` when left out. */
  format?: () => RenderFormat
  /** What a failed run keeps of the error: cli-memo turns a Commander or Valibot error into a CLI error first. */
  recognise?: (error: unknown) => unknown
  env?: NodeJS.ProcessEnv
  streams?: Streams
}

/** One command's run at a time, for a CLI that starts and ends it from its own hooks (zoom-cli under `run()`). */
export interface CommandRuns {
  start(action: Command): void
  succeed(): Promise<void>
  fail(error: unknown): Promise<void>
  /** The id the command's run has, kept or not, so its answer can name it. */
  runId(): string | undefined
  events(event: RequestEvent): void
}

const SKIPPED = new Set(["runs", "help"])

const pathOf = (command: Command): string[] => {
  const words: string[] = []
  for (let at: Command | null = command; at?.parent; at = at.parent) words.unshift(at.name())
  return words
}

type Tracker = CommandRuns & {
  /** A line that failed before any action, named from its words. */
  open(program: Command, words: string[], flag: boolean | undefined, format: RenderFormat): void
}

const tracker = (options: CommandRunOptions, typed?: readonly string[]): Tracker => {
  let recording: Recording | undefined

  const open: Tracker["open"] = (program, words, flag, format) => {
    recording = undefined
    // Reading the log is not worth a run of its own.
    if (SKIPPED.has(words[0] ?? "")) return
    const environment = environmentOf(program)
    let saved: SavedRunSettings = {}
    try {
      saved = options.settings()
    } catch {
      saved = { recordInput: false }
    }
    let profile: string | undefined
    try {
      profile = options.profile?.() || undefined
    } catch {}
    const settings = runSettings(flag, saved)
    const agent = options.agent ?? environment.agent !== undefined
    const streams = options.streams ?? environment.streams
    const env = options.env ?? environment.env
    const command = `${agent ? "mcp " : ""}${words.join(" ") || options.app.command}`
    recording = startRecording({
      app: options.app,
      command,
      ...(profile === undefined ? {} : { profile }),
      record: settings.record,
      keepFailed: settings.keepFailedRuns,
      keepDays: settings.keepRunsForDays,
      trace: false,
      format,
      ...(streams ? { streams } : {}),
      ...(env ? { env } : {}),
      context: runContextOf({
        bin: options.app.command,
        command: words.length > 0 ? command : "",
        program: rootOf(program),
        ...((environment.argv ?? typed) ? { argv: environment.argv ?? typed } : {}),
        env: env ?? process.env,
        recordInput: saved.recordInput !== false,
      }),
    })
  }

  const finish = () => {
    const done = recording
    recording = undefined
    return done
  }

  return {
    start(action) {
      const flags = action.optsWithGlobals<{ record?: boolean; json?: unknown; jsonl?: unknown }>()
      const json = (flags.json !== undefined && flags.json !== false) || Boolean(flags.jsonl)
      open(action, pathOf(action), flags.record, options.format?.() ?? (json ? "json" : "pretty"))
    },
    async succeed() {
      await finish()?.succeed()
    },
    async fail(error) {
      await finish()?.fail(options.recognise ? options.recognise(error) : error)
    },
    runId: () => recording?.runId,
    events: (event) => recording?.events(event),
    open,
  }
}

export const commandRuns = (options: CommandRunOptions): CommandRuns => tracker(options)

interface Parse {
  runs: Tracker
  started: boolean
}

const parses = new AsyncLocalStorage<Parse>()

/** For a provider client far from the program: the event lands in the current command's run, or nowhere. */
export const providerEvent = (event: RequestEvent): void => parses.getStore()?.runs.events(event)

/**
 * Times one provider call under a fixed operation name — nothing the call carries goes into the run. The returned
 * function ends it; an `error` or an `errorCode` makes it a failed one.
 */
export const providerRequest = (operation: string, sink: (event: RequestEvent) => void = providerEvent) => {
  sink({ event: "request", operation })
  const started = performance.now()
  return ({ status, error, errorCode }: { status?: number; error?: unknown; errorCode?: string } = {}): void => {
    const failed = error !== undefined || errorCode !== undefined
    sink({
      event: "response",
      operation,
      ...(status === undefined ? {} : { status }),
      durationMs: Math.round(performance.now() - started),
      outcome: failed ? "error" : "ok",
      ...(failed ? { errorCode: errorCode ?? (isCliError(error) ? error.code : "provider_error") } : {}),
    })
  }
}

/** `files list` from `files list abc --limit 5`: command words only, never an argument. */
const pathFromArgs = (program: Command, args: readonly string[], profileWord: boolean): string[] => {
  const words: string[] = []
  let at = program
  let skipped = !profileWord
  for (const arg of args) {
    if (arg.startsWith("-")) continue
    const next = at.commands.find((one) => one.name() === arg || one.aliases().includes(arg))
    if (next) {
      words.push(arg)
      at = next
    } else if (words.length === 0 && !skipped) skipped = true
    else break
  }
  return words
}

const isHelpExit = (error: unknown): boolean => {
  const { code, exitCode } = (error ?? {}) as { code?: unknown; exitCode?: unknown }
  return typeof code === "string" && code.startsWith("commander.") && (exitCode === 0 || code === "commander.help")
}

/**
 * WC-LIFE-15 for a CLI with its own commander program (`startCli`, not `run()`): adds `--record` and `--no-record`,
 * keeps every failed command as a run — a usage error before any action too — and every command when recording is
 * on. Call it after the program's other `parseAsync` wrappers, so its own is the outermost and sees how the parse
 * really ended; a refusal in an earlier `preAction` hook is then kept under the words read from the line.
 */
export const recordRuns = (program: Command, options: CommandRunOptions): void => {
  program
    .option(
      "--record",
      "keep this run, with the command as typed and secrets hidden; record_input false leaves the typed words out",
    )
    .option("--no-record", "do not keep this run, even if it fails")
  program.hook("preAction", (_root, action) => {
    const parse = parses.getStore()
    if (!parse) return
    parse.started = true
    parse.runs.start(action)
  })
  const parseAsync = program.parseAsync.bind(program)
  program.parseAsync = (argv, settings) => {
    const args = settings?.from === "user" ? (argv ?? []) : (argv ?? process.argv).slice(2)
    const parse: Parse = { runs: tracker(options, args), started: false }
    return parses.run(parse, async () => {
      try {
        const parsed = await parseAsync(argv, settings)
        await parse.runs.succeed()
        return parsed
      } catch (error) {
        if (!isHelpExit(error) && !wasSettled(error)) {
          try {
            if (!parse.started) {
              const flag = args.includes("--no-record") ? false : args.includes("--record") ? true : undefined
              const json = args.some((arg) => arg === "--json" || arg.startsWith("--json=") || arg === "--jsonl")
              const words = pathFromArgs(program, args, options.profile !== undefined)
              const format = options.format?.() ?? (json ? "json" : "pretty")
              parse.runs.open(program, words, flag, format)
            }
            await parse.runs.fail(error)
          } catch {}
        }
        throw error
      }
    })
  }
}
