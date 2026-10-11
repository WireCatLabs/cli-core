import { CliError, type Renderer, type RenderFormat, type Streams } from "@wirecat/cli-core"
import type { Command } from "commander"
import { resolveOutput } from "../output.js"
import type { OpenRecognizer } from "../speech/transcribe.js"
import type { AppIdentity } from "./app.js"
import { type Closeable, withDeadline } from "./deadline.js"
import { withAbort } from "./execution.js"
import { rootOf } from "./profile.js"
import type { EventSink } from "./runs/events.js"
import { recorded } from "./runs/recording.js"
import type { GlobalFlags, ResolveOptions, Settings } from "./settings.js"

/** What every CLI's commands write to, when it is not the real terminal. A CLI adds its own fields. */
export interface BaseEnvironment {
  streams?: Streams
  /** Whether a person is looking. Defaults to whether stdout is a terminal. */
  tty?: boolean
  env?: NodeJS.ProcessEnv
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
  /** The local speech recognizer in place of the downloaded model; tests hand one in. */
  recognizer?: OpenRecognizer
}

const environments = new WeakMap<Command, BaseEnvironment>()

export const provide = (program: Command, environment: BaseEnvironment): void => {
  environments.set(program, environment)
}

export const environmentOf = <E extends BaseEnvironment = BaseEnvironment>(command: Command): E =>
  (environments.get(rootOf(command)) ?? {}) as E

/** For the commands that print but never need settings or a connection. */
export const outputFor = (command: Command) => {
  const { streams, tty, env } = environmentOf(command)
  return resolveOutput({
    ...command.optsWithGlobals(),
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
  const settings = resolveSettings(command.optsWithGlobals<GlobalFlags>(), { env })
  const { renderer, format, color, streams } = resolveOutput({
    ...settings,
    env,
    ...detailOf(command.optsWithGlobals<{ brief?: boolean; full?: boolean }>()),
    ...(command.optsWithGlobals<{ fields?: string }>().fields
      ? { fields: command.optsWithGlobals<{ fields?: string }>().fields }
      : {}),
    ...(environment.streams ? { streams: environment.streams } : {}),
    ...(environment.tty === undefined ? {} : { tty: environment.tty }),
  })
  const closeables: Closeable[] = []

  return {
    settings,
    renderer,
    format,
    color,
    streams,
    env,
    // The deadline inside the record, so a timeout finishes the run as failed rather than leaving it running.
    run: (body, { unbounded = false, name } = {}) =>
      environment.app
        ? recorded(
            {
              app: environment.app,
              command: name ?? commandPath(command),
              profile: settings.profile,
              record: settings.record,
              keepFailed: settings.keepFailedRuns,
              trace: settings.trace,
              keepDays: settings.keepRunsForDays,
              format,
              streams,
              env,
            },
            (events) =>
              withAbort(environment.commandSignal, () =>
                withDeadline(unbounded ? undefined : settings.commandTimeoutMs, closeables, () => body(events)),
              ),
          )
        : withAbort(environment.commandSignal, () =>
            withDeadline(unbounded ? undefined : settings.commandTimeoutMs, closeables, () => body(() => {})),
          ),
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
