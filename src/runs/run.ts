import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { userInfo } from "node:os"
import { join, sep } from "node:path"
import { createRecordLog, type Logger, resolvePaths, writeSecurely } from "@wirecat/cli-base"
import type { AppIdentity } from "../ports/app.js"
import type { RunError } from "./error-detail.js"
import { LOG_ATTRIBUTES } from "./log-attributes.js"
import { fromLogAttributes, logAttributes, snakeLogger } from "./log-keys.js"
import type { RunAgent, RunMcp, RunVia } from "./run-context.js"

export type RunStatus = "success" | "failed" | "partial"

/**
 * What a run was, and how it ended. **It never says what was read or sent** — a command, a profile,
 * a count, the arguments with every value that may be content masked, and the `errorCode` a script
 * branches on. The sentence a person reads is kept only in `error`, masked, because a messenger's
 * refusal can quote the payload back.
 */
export interface RunMetadata {
  runId: string
  /** As typed, without the arguments: `chats list`, `messages send`. */
  command: string
  /** Left out when the command named no profile. */
  profile?: string
  startedAt: string
  completedAt?: string
  status: RunStatus | "running"
  /** How many calls reached the messenger: wire calls when the transport logs them, otherwise operations. */
  requests?: number
  /** Events past the run's cap, counted rather than written; an `events.dropped` line says which. */
  eventsDropped?: number
  durationMs?: number
  cliVersion: string
  /** `node 24.1.0` or `bun 1.3.14`, and where: what a problem report is asked for first. */
  runtime?: string
  platform?: string
  arch?: string
  errorCode?: string
  partial?: {
    failed: number
    stopReason?: string
    failures: { id: string; stage: string; errorCode: string; attachment?: number }[]
  }
  /** The messenger's key for the refusal that ended it, when there was one (`providerErrorKey`). */
  providerError?: string
  /** Written only because it failed: recording was not asked for. */
  keptBecauseFailed?: boolean
  /** Every operation its events named, so a search by operation need not open them. */
  operations?: string[]
  /** Every `errorCode` and warning `code` its events carried, for the same reason. */
  codes?: string[]
  /** The caller's trace: the MCP client's, or the schedule's or job's that started it. */
  traceId?: string
  /** The whole command with the program's name, `max messages list`; `command` stays the run's short name. */
  cliCommand?: string
  /** The words after the program's name, a secret `[redacted]`; with `record_input` off, any value that may be content too (`maskArgv`). */
  argv?: string[]
  /** The word that named no command, when that is why the run failed. */
  unknownCommand?: string
  /** The coding agent that started it, when one did, and the MCP client that made the call. */
  agent?: RunAgent
  /** How it was asked for (`viaOf`, or the MCP server that received it). */
  via?: RunVia
  /** The MCP call it answered. */
  mcp?: RunMcp
  /** How a failed run failed (`errorDetailOf`). */
  error?: RunError
}

/** Who started a run and with what, known before it starts. */
export type RunContext = Pick<RunMetadata, "cliCommand" | "argv" | "unknownCommand" | "agent" | "via" | "mcp">

export interface StartRunOptions {
  runsDir: string
  command: string
  profile?: string
  /** The log record's `resource.service`: the program's own name, `tg` or `max`. */
  service: string
  cliVersion: string
  /** Older runs are removed as this one starts. */
  keepDays?: number
  /** Successful runs older than this are removed sooner than the failures `keepDays` keeps. */
  keepSuccessDays?: number
  /** The runs folder's size limit in bytes: past it, the oldest successful runs go first, then the oldest days. */
  maxBytes?: number
  /**
   * Opens the directory only when there is something to put in it: an event, or an ending other than a plain
   * success. A success with no events is then one line in the day's index (`runs show` reads it from there).
   */
  lazy?: boolean
  runId?: string
  now?: () => Date
  /** When the command began, if that was before the run was opened — a failure kept after the fact. */
  startedAt?: Date
  /** The caller's trace, written on every record as `trace_id`. */
  traceId?: string
  context?: RunContext
  /** The log file could not be opened or written; the run goes on unrecorded from here. */
  onError?: (error: Error) => void
}

export interface Run {
  id: string
  dir: string
  logger: Logger
  /**
   * Writes the final `run.json`. **Must run on every path** — the answer, a
   * refusal, a failure before the connection was even open. Safe to call twice.
   */
  finish(status: RunStatus, extra?: Partial<RunMetadata>): Promise<void>
}

export const KEEP_RUNS_FOR_DAYS = 30
export const KEEP_SUCCESSFUL_RUNS_FOR_DAYS = 7
export const RUNS_SIZE_LIMIT_MB = 200

/** `<state dir>/runs` — never the cache directory: a cache is deleted to fix a cache, and a run cannot be rebuilt. */
export const runsDirFor = (app: AppIdentity, env: NodeJS.ProcessEnv = process.env): string =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "runs")

/**
 * Opens a run directory.
 *
 * ```text
 * <state dir>/runs/2026-09-20/20260920T084431Z-chats-list-a81f2c/
 *   run.json       what it was, when, which profile, how long, the outcome
 *   events.jsonl   one log record per event (cli-base's `LogRecord`), no ANSI ever
 * ```
 *
 * `run.json` is written as the directory opens, with `status: "running"`, and again by `finish`. A directory
 * holding events and no metadata is a special case `runs list` would carry forever.
 *
 * Each write also appends the metadata to the day's `index.jsonl`, which `runs list` and `search runs`
 * read instead of every `run.json`. It is the only record of a `lazy` run that succeeded without events.
 */
export const startRun = (options: StartRunOptions): Run => {
  const now = options.now ?? (() => new Date())
  const startedAt = options.startedAt ?? now()
  const id = options.runId ?? newRunId(startedAt, options.command)
  const dir = join(options.runsDir, day(startedAt), id)

  // Only while something is being recorded: a tool that is not recording has no business walking
  // that directory.
  pruneRuns(options.runsDir, {
    keepDays: options.keepDays ?? KEEP_RUNS_FOR_DAYS,
    keepSuccessDays: options.keepSuccessDays ?? KEEP_SUCCESSFUL_RUNS_FOR_DAYS,
    maxBytes: options.maxBytes ?? RUNS_SIZE_LIMIT_MB * 1024 * 1024,
    now: startedAt,
  })
  refuseRealStateInTests(dir)

  const metadata: RunMetadata = {
    runId: id,
    command: options.command,
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    startedAt: startedAt.toISOString(),
    status: "running",
    cliVersion: options.cliVersion,
    runtime: runtime(),
    platform: process.platform,
    arch: process.arch,
    ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
    ...options.context,
  }

  let file: Logger | undefined
  const opened = (): Logger => {
    if (file) return file
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // Created here rather than by the logger, which opens with whatever the umask allows. The
    // directory is already 0700, so this is the second lock rather than the first — but a log file
    // that outlives its directory, or is copied out of it, should not be the one that is readable.
    const events = join(dir, "events.jsonl")
    writeFileSync(events, "", { flag: "a", mode: 0o600 })
    file = snakeLogger(
      createRecordLog({
        to: events,
        runId: id,
        command: options.command,
        resource: { service: options.service, version: options.cliVersion },
        allow: LOG_ATTRIBUTES,
        ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
        ...(options.onError === undefined ? {} : { onError: options.onError }),
      }),
    )
    writeRunFile(dir, metadata)
    return file
  }
  if (!options.lazy) opened()

  const operations = new Set<string>()
  const codes = new Set<string>()
  const noted =
    (level: keyof Logger) =>
    (event: object, message?: string): void => {
      const { operation, errorCode, error_code, code } = event as Record<string, unknown>
      if (typeof operation === "string") operations.add(operation)
      for (const value of [errorCode, error_code, code]) if (typeof value === "string") codes.add(value)
      opened()[level](event, message)
    }
  const logger: Logger = { debug: noted("debug"), info: noted("info"), warn: noted("warn"), error: noted("error") }

  let finished = false

  return {
    id,
    dir,
    logger,
    finish: async (status, extra = {}) => {
      if (finished) return
      finished = true

      const completedAt = now()
      const final: RunMetadata = {
        ...metadata,
        ...extra,
        status,
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        operations: [...operations].sort(),
        codes: [...codes].sort(),
      }
      if (file || status !== "success") {
        opened()
        writeRunFile(dir, final)
        return
      }
      try {
        mkdirSync(join(dir, ".."), { recursive: true, mode: 0o700 })
        appendIndex(join(dir, ".."), runFileOf(final))
      } catch (error) {
        options.onError?.(error as Error)
      }
    },
  }
}

/**
 * The test sandbox moves HOME and the XDG folders, so a run that still resolves into the owner's own data folder is a
 * fixture that bypassed it: thousands of test runs once landed beside the owner's real ones. The passwd entry's home
 * is read because HOME is the very thing the sandbox changed.
 */
export const refuseRealStateInTests = (dir: string, env: NodeJS.ProcessEnv = process.env): void => {
  if (env.VITEST === undefined) return
  let home: string
  try {
    home = userInfo().homedir
  } catch {
    return
  }
  if (dir.startsWith(join(home, ".local", "share") + sep))
    throw new Error(`a test opened a run in the real data folder: ${dir}`)
}

export const runtime = (): string => {
  const bun = (process.versions as Record<string, string | undefined>).bun
  return bun ? `bun ${bun}` : `node ${process.versions.node}`
}

/** `20260920T084431Z-chats-list-a81f2c` — sortable, and readable without opening it. */
export const newRunId = (startedAt: Date, command: string): string => {
  const stamp = startedAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
  const slug = command.replace(/[^a-z0-9]+/gi, "-").toLowerCase()
  return `${stamp}-${slug}-${randomUUID().slice(0, 6)}`
}

const INDEX = "index.jsonl"

const appendIndex = (dayDir: string, written: Record<string, unknown>): void => {
  appendFileSync(join(dayDir, INDEX), `${JSON.stringify(written)}\n`, { mode: 0o600 })
}

const writeRunFile = (dir: string, metadata: RunMetadata): void => {
  // Atomic, so a reader never sees half of one — and 0600, because it names a profile and a
  // command even though it carries nothing of what was said.
  const written = runFileOf(metadata)
  writeSecurely(join(dir, "run.json"), `${JSON.stringify(written, null, 2)}\n`, 0o600)
  try {
    appendIndex(join(dir, ".."), written)
  } catch {
    // A day without an index is read run by run.
  }
}

export interface RunListFilter {
  runId?: string
  command?: string
  profile?: string
  status?: RunMetadata["status"]
  errorCode?: string
}

const matchesListFilter = (run: RunMetadata, filter: RunListFilter): boolean =>
  (filter.runId === undefined || run.runId === filter.runId) &&
  (filter.command === undefined || run.command === filter.command) &&
  (filter.profile === undefined || run.profile === filter.profile) &&
  (filter.status === undefined || run.status === filter.status) &&
  (filter.errorCode === undefined || run.errorCode === filter.errorCode)

/**
 * Newest first, which is the order anyone asking "what did I just do" wants. Days before `since` are
 * not opened, nor any day once `atLeast` runs are in hand.
 */
export const listRuns = (
  runsDir: string,
  {
    since,
    atLeast = Number.POSITIVE_INFINITY,
    filter = {},
  }: { since?: number; atLeast?: number; filter?: RunListFilter } = {},
): RunMetadata[] => {
  const first = since === undefined ? undefined : day(new Date(since))
  const runs: RunMetadata[] = []

  for (const date of days(runsDir).sort().reverse()) {
    if ((first !== undefined && date < first) || runs.length >= atLeast) break
    for (const metadata of runsOfDay(join(runsDir, date))) {
      if (matchesListFilter(metadata, filter)) runs.push(metadata)
    }
  }
  return runs
}

/**
 * The index says what it holds; a run it does not name — written before there was an index, by an older
 * process still running, or when the append failed — is read from its own `run.json`.
 */
const indexedRuns = (dayDir: string): Map<string, RunMetadata> => {
  const latest = new Map<string, RunMetadata>()
  let raw = ""
  try {
    raw = readFileSync(join(dayDir, INDEX), "utf8")
  } catch {}
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue
    try {
      const metadata = metadataOf(JSON.parse(line))
      if (typeof metadata.runId === "string") latest.set(metadata.runId, metadata)
    } catch {
      // A torn line from a killed process; that run's next line, or its run.json, still says it.
    }
  }
  return latest
}

const runsOfDay = (dayDir: string): RunMetadata[] => {
  const latest = indexedRuns(dayDir)
  for (const entry of safeReaddir(dayDir)) {
    if (entry === INDEX || entry.startsWith(".") || latest.has(entry)) continue
    const metadata = readRun(join(dayDir, entry))
    if (metadata) latest.set(metadata.runId, metadata)
  }
  return [...latest.values()].sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0))
}

export const findRun = (runsDir: string, id: string): { dir: string; metadata: RunMetadata } | undefined => {
  const stamped = /^(\d{4})(\d{2})(\d{2})T/.exec(id)
  const likely = stamped ? [`${stamped[1]}-${stamped[2]}-${stamped[3]}`] : []
  const dates = [...new Set([...likely, ...days(runsDir)])]
  for (const date of dates) {
    const dir = join(runsDir, date, id)
    const metadata = readRun(dir)
    if (metadata) return { dir, metadata }
  }
  // A success that logged no events is a line in its day's index and nothing else.
  for (const date of dates) {
    const metadata = indexedRuns(join(runsDir, date)).get(id)
    if (metadata) return { dir: join(runsDir, date, id), metadata }
  }
  return undefined
}

/**
 * The events of one run, in the order they happened: each record's `attributes` with its `time` and
 * `severity` beside them. A line that will not parse is skipped.
 */
export const readEvents = (dir: string): Record<string, unknown>[] => {
  let raw: string
  try {
    raw = readFileSync(join(dir, "events.jsonl"), "utf8")
  } catch {
    return []
  }

  const events: Record<string, unknown>[] = []
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed !== null && typeof parsed === "object") events.push(eventOf(parsed as Record<string, unknown>))
    } catch {
      // A half-written last line is what a killed process leaves behind. The rest of the file is
      // still the run somebody wants to read.
    }
  }
  return events
}

/** A run kept before records were written holds the event's fields at the top of each line. */
const eventOf = (line: Record<string, unknown>): Record<string, unknown> => {
  const { attributes, time, severity } = line
  if (attributes === null || typeof attributes !== "object") return logAttributes(line)
  return { time, severity, ...logAttributes(attributes) }
}

/**
 * Removes every day older than `keepDays`, then the successful runs of every day older than `keepSuccessDays`, and
 * answers how many days went. Then, once a day, the folder is measured against `maxBytes`: successful runs go first,
 * oldest day first, then whole days, until it fits.
 *
 * A day at a time, by the directory name and the day's index, so no run has to be opened to decide — and a directory
 * that is not a date is left alone rather than guessed at.
 */
export const pruneRuns = (
  runsDir: string,
  {
    keepDays,
    keepSuccessDays = keepDays,
    maxBytes,
    now,
  }: { keepDays: number; keepSuccessDays?: number; maxBytes?: number; now: Date },
): number => {
  const cutoff = day(new Date(now.getTime() - keepDays * DAY_MS))
  const successCutoff = day(new Date(now.getTime() - Math.min(keepSuccessDays, keepDays) * DAY_MS))

  let removed = 0
  for (const date of days(runsDir)) {
    if (date >= cutoff) {
      if (date < successCutoff) dropSuccesses(join(runsDir, date))
      continue
    }
    try {
      rmSync(join(runsDir, date), { recursive: true, force: true })
      removed += 1
    } catch {
      // A day we cannot remove is not a reason to fail the command that was only starting.
    }
  }
  if (maxBytes !== undefined) removed += fitSize(runsDir, maxBytes, now)
  return removed
}

const DAY_MS = 24 * 60 * 60 * 1000
const SUCCESSES_DROPPED = ".successes-dropped"
const SIZE_CHECKED = ".size-checked"

/** A day's successful runs, out of its index and off the disk; once per day, marked by a file beside them. */
const dropSuccesses = (dayDir: string): void => {
  const marker = join(dayDir, SUCCESSES_DROPPED)
  try {
    statSync(marker)
    return
  } catch {}
  try {
    const kept: string[] = []
    for (const [id, metadata] of indexedRuns(dayDir)) {
      if (metadata.status === "success") rmSync(join(dayDir, id), { recursive: true, force: true })
      else kept.push(JSON.stringify(runFileOf(metadata)))
    }
    for (const entry of safeReaddir(dayDir)) {
      if (entry === INDEX || entry.startsWith(".")) continue
      if (readRun(join(dayDir, entry))?.status === "success")
        rmSync(join(dayDir, entry), { recursive: true, force: true })
    }
    writeSecurely(join(dayDir, INDEX), kept.map((line) => `${line}\n`).join(""), 0o600)
    writeFileSync(marker, "", { mode: 0o600 })
  } catch {
    // Tried again at the next run's start.
  }
}

const sizeOf = (path: string): number => {
  let total = 0
  for (const entry of safeReaddir(path)) {
    const full = join(path, entry)
    try {
      const stat = statSync(full)
      total += stat.isDirectory() ? sizeOf(full) : stat.size
    } catch {}
  }
  return total
}

/** Measuring walks every file, so it runs at most once a day; a burst can overshoot until the next day's check. */
const fitSize = (runsDir: string, maxBytes: number, now: Date): number => {
  const stamp = join(runsDir, SIZE_CHECKED)
  const today = day(now)
  try {
    if (readFileSync(stamp, "utf8").trim() === today) return 0
  } catch {}
  const dates = days(runsDir).sort()
  const sizes = new Map(dates.map((date) => [date, sizeOf(join(runsDir, date))]))
  let total = [...sizes.values()].reduce((sum, size) => sum + size, 0)
  let removed = 0
  // Today is left to the age rule: a day marked done would keep the successes it gains later.
  for (const date of dates) {
    if (total <= maxBytes || date === today) break
    dropSuccesses(join(runsDir, date))
    const after = sizeOf(join(runsDir, date))
    total -= (sizes.get(date) ?? 0) - after
    sizes.set(date, after)
  }
  for (const date of dates) {
    if (total <= maxBytes || date === today) break
    try {
      rmSync(join(runsDir, date), { recursive: true, force: true })
      total -= sizes.get(date) ?? 0
      removed += 1
    } catch {}
  }
  try {
    mkdirSync(runsDir, { recursive: true, mode: 0o700 })
    writeFileSync(stamp, today, { mode: 0o600 })
  } catch {}
  return removed
}

const day = (date: Date): string => date.toISOString().slice(0, 10)

const days = (runsDir: string): string[] => safeReaddir(runsDir).filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry))

const readRun = (dir: string): RunMetadata | undefined => {
  try {
    return metadataOf(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")))
  } catch {
    return undefined
  }
}

const safeReaddir = (dir: string): string[] => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** `run.json` and the index hold the metadata in snake_case, `partial` included. */
const runFileOf = ({ partial, ...metadata }: RunMetadata): Record<string, unknown> => ({
  ...logAttributes(metadata),
  ...(partial
    ? { partial: { ...logAttributes(partial), failures: partial.failures.map((failure) => logAttributes(failure)) } }
    : {}),
})

/** A run written either way, before or after its keys were snake_case. */
const metadataOf = (parsed: Record<string, unknown>): RunMetadata => {
  const { partial, ...metadata } = fromLogAttributes(parsed)
  if (partial === null || typeof partial !== "object") return metadata as unknown as RunMetadata
  const { failures, ...rest } = fromLogAttributes(partial)
  return {
    ...metadata,
    partial: {
      ...rest,
      failures: Array.isArray(failures) ? failures.map((failure: object) => fromLogAttributes(failure)) : [],
    },
  } as unknown as RunMetadata
}
