import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createFileLogger, type FileLogger, resolvePaths, writeSecurely } from "@wirecat/cli-base"
import type { AppIdentity } from "../app.js"

export type RunStatus = "success" | "failed" | "partial"

/**
 * What a run was, and how it ended. **It never says what was read or sent** — a command, a profile
 * and a count, and the `errorCode` a script branches on rather than the sentence a person reads,
 * because a messenger's refusal can quote the payload back.
 */
export interface RunMetadata {
  runId: string
  /** As typed, without the arguments: `chats list`, `messages send`. */
  command: string
  profile: string
  startedAt: string
  completedAt?: string
  status: RunStatus | "running"
  /** How many operations reached the messenger. */
  requests?: number
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
}

export interface StartRunOptions {
  runsDir: string
  command: string
  profile: string
  cliVersion: string
  /** Older runs are removed as this one starts. */
  keepDays?: number
  runId?: string
  now?: () => Date
  /** When the command began, if that was before the run was opened — a failure kept after the fact. */
  startedAt?: Date
  /** The log file could not be opened or written; the run goes on unrecorded from here. */
  onError?: (error: Error) => void
}

export interface Run {
  id: string
  dir: string
  logger: FileLogger
  /**
   * Writes the final `run.json` and closes the log. **Must run on every path** — the answer, a
   * refusal, a failure before the connection was even open. Safe to call twice.
   */
  finish(status: RunStatus, extra?: Partial<RunMetadata>): Promise<void>
}

export const KEEP_RUNS_FOR_DAYS = 30

/** `<state dir>/runs` — never the cache directory: a cache is deleted to fix a cache, and a run cannot be rebuilt. */
export const runsDirFor = (app: AppIdentity, env: NodeJS.ProcessEnv = process.env): string =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "runs")

/**
 * Opens a run directory.
 *
 * ```text
 * <state dir>/runs/2026-09-20/20260920T084431Z-chats-list-a81f2c/
 *   run.json       what it was, when, which profile, how long, the outcome
 *   events.jsonl   one JSON object per request, written by Pino, no ANSI ever
 * ```
 *
 * `run.json` is written **now**, with `status: "running"`, and again by `finish`. A directory
 * holding events and no metadata is a special case `runs list` would carry forever.
 *
 * Each write also appends the metadata to the day's `index.jsonl`, which `runs list` and `runs search`
 * read instead of every `run.json`. It is only a cache: pruned with its day, and a day without one is read
 * the slow way.
 */
export const startRun = (options: StartRunOptions): Run => {
  const now = options.now ?? (() => new Date())
  const startedAt = options.startedAt ?? now()
  const id = options.runId ?? runId(startedAt, options.command)
  const dir = join(options.runsDir, day(startedAt), id)

  // Only while something is being recorded: a tool that is not recording has no business walking
  // that directory.
  pruneRuns(options.runsDir, { keepDays: options.keepDays ?? KEEP_RUNS_FOR_DAYS, now: startedAt })

  mkdirSync(dir, { recursive: true, mode: 0o700 })

  // Created here rather than by the logger, which opens with whatever the umask allows. The
  // directory is already 0700, so this is the second lock rather than the first — but a log file
  // that outlives its directory, or is copied out of it, should not be the one that is readable.
  const events = join(dir, "events.jsonl")
  writeFileSync(events, "", { flag: "a", mode: 0o600 })

  const file = createFileLogger({
    path: events,
    base: { runId: id, command: options.command, profile: options.profile },
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  })
  const operations = new Set<string>()
  const codes = new Set<string>()
  const noted =
    (write: (event: object, message?: string) => void) =>
    (event: object, message?: string): void => {
      const { operation, errorCode, code } = event as Record<string, unknown>
      if (typeof operation === "string") operations.add(operation)
      for (const value of [errorCode, code]) if (typeof value === "string") codes.add(value)
      write(event, message)
    }
  const logger: FileLogger = {
    debug: noted(file.debug),
    info: noted(file.info),
    warn: noted(file.warn),
    error: noted(file.error),
    close: file.close,
  }

  const metadata: RunMetadata = {
    runId: id,
    command: options.command,
    profile: options.profile,
    startedAt: startedAt.toISOString(),
    status: "running",
    cliVersion: options.cliVersion,
    runtime: runtime(),
    platform: process.platform,
    arch: process.arch,
  }
  writeRunFile(dir, metadata)

  let finished = false

  return {
    id,
    dir,
    logger,
    finish: async (status, extra = {}) => {
      if (finished) return
      finished = true

      const completedAt = now()
      writeRunFile(dir, {
        ...metadata,
        ...extra,
        status,
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        operations: [...operations].sort(),
        codes: [...codes].sort(),
      })

      // Pino writes through a plain append stream, and a process that exits before it flushes
      // loses the tail — which is exactly the run somebody wanted to read.
      await logger.close()
    },
  }
}

export const runtime = (): string => {
  const bun = (process.versions as Record<string, string | undefined>).bun
  return bun ? `bun ${bun}` : `node ${process.versions.node}`
}

/** `20260920T084431Z-chats-list-a81f2c` — sortable, and readable without opening it. */
const runId = (startedAt: Date, command: string): string => {
  const stamp = startedAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
  const slug = command.replace(/[^a-z0-9]+/gi, "-").toLowerCase()
  return `${stamp}-${slug}-${randomUUID().slice(0, 6)}`
}

const INDEX = "index.jsonl"

const writeRunFile = (dir: string, metadata: RunMetadata): void => {
  // Atomic, so a reader never sees half of one — and 0600, because it names a profile and a
  // command even though it carries nothing of what was said.
  writeSecurely(join(dir, "run.json"), `${JSON.stringify(metadata, null, 2)}\n`, 0o600)
  try {
    appendFileSync(join(dir, "..", INDEX), `${JSON.stringify(metadata)}\n`, { mode: 0o600 })
  } catch {
    // The index only makes reading faster; a day without one is read run by run.
  }
}

/**
 * Newest first, which is the order anyone asking "what did I just do" wants. Days before `since` are
 * not opened, nor any day once `atLeast` runs are in hand.
 */
export const listRuns = (
  runsDir: string,
  { since, atLeast = Number.POSITIVE_INFINITY }: { since?: number; atLeast?: number } = {},
): RunMetadata[] => {
  const first = since === undefined ? undefined : day(new Date(since))
  const runs: RunMetadata[] = []

  for (const date of days(runsDir).sort().reverse()) {
    if ((first !== undefined && date < first) || runs.length >= atLeast) break
    runs.push(...runsOfDay(join(runsDir, date)))
  }
  return runs
}

const runsOfDay = (dayDir: string): RunMetadata[] => {
  let raw: string
  try {
    raw = readFileSync(join(dayDir, INDEX), "utf8")
  } catch {
    return safeReaddir(dayDir)
      .filter((entry) => entry !== INDEX)
      .sort()
      .reverse()
      .flatMap((entry) => readRun(join(dayDir, entry)) ?? [])
  }

  const latest = new Map<string, RunMetadata>()
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue
    try {
      const metadata = JSON.parse(line) as RunMetadata
      if (typeof metadata.runId === "string") latest.set(metadata.runId, metadata)
    } catch {
      // A torn line from a killed process; that run's next line, or its run.json, still says it.
    }
  }
  return [...latest.values()].sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0))
}

export const findRun = (runsDir: string, id: string): { dir: string; metadata: RunMetadata } | undefined => {
  const stamped = /^(\d{4})(\d{2})(\d{2})T/.exec(id)
  const likely = stamped ? [`${stamped[1]}-${stamped[2]}-${stamped[3]}`] : []
  for (const date of [...likely, ...days(runsDir)]) {
    const dir = join(runsDir, date, id)
    const metadata = readRun(dir)
    if (metadata) return { dir, metadata }
  }
  return undefined
}

/** The events of one run, in the order they happened. A line that will not parse is skipped. */
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
      if (parsed !== null && typeof parsed === "object") events.push(parsed as Record<string, unknown>)
    } catch {
      // A half-written last line is what a killed process leaves behind. The rest of the file is
      // still the run somebody wants to read.
    }
  }
  return events
}

/**
 * Removes every day older than `keepDays`, and answers how many days went.
 *
 * A whole day at a time, by the directory name, so nothing has to be opened to decide — and a
 * directory that is not a date is left alone rather than guessed at.
 */
export const pruneRuns = (runsDir: string, { keepDays, now }: { keepDays: number; now: Date }): number => {
  const cutoff = day(new Date(now.getTime() - keepDays * 24 * 60 * 60 * 1000))

  let removed = 0
  for (const date of days(runsDir)) {
    if (date >= cutoff) continue
    try {
      rmSync(join(runsDir, date), { recursive: true, force: true })
      removed += 1
    } catch {
      // A day we cannot remove is not a reason to fail the command that was only starting.
    }
  }
  return removed
}

const day = (date: Date): string => date.toISOString().slice(0, 10)

const days = (runsDir: string): string[] => safeReaddir(runsDir).filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry))

const readRun = (dir: string): RunMetadata | undefined => {
  try {
    return JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as RunMetadata
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
