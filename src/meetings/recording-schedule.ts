import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import { snapshotMeetingScope } from "./provider.js"
import type { RecordingScope, RecordingWindow } from "./recording-source.js"
import { recordingWindows } from "./recording-sync.js"

export interface RecordingArchiveSchedule {
  version: 1
  id: string
  name: string
  scope: RecordingScope
  destination: string
  from: string
  dailyAt: string
  timeZone: string
  lookbackDays: number
  maxBytes: number
  createdAt: number
}

export interface RecordingArchiveScheduleInput {
  name: string
  scope: RecordingScope
  destination: string
  from: string
  dailyAt: string
  timeZone: string
  lookbackDays?: number
  maxBytes?: number
}

export interface RecordingArchiveScheduler {
  readonly backend: string
  install(schedule: RecordingArchiveSchedule, options: { signal?: AbortSignal }): Promise<void>
}

const fail = (message: string): never => {
  throw new CliError("validation_error", message)
}
const text = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && !!value.trim() && value.length <= maximum && !/[\0\r\n]/.test(value)
const clock = (now: number): Date => {
  if (!Number.isSafeInteger(now) || now < 0 || now > 253402300799999) fail("invalid archive schedule clock")
  return new Date(now)
}
const day = (instant: Date): string => instant.toISOString().slice(0, 10)
const identity = (schedule: Omit<RecordingArchiveSchedule, "version" | "id" | "createdAt">): string =>
  createHash("sha256").update(JSON.stringify(schedule)).digest("hex")

export const planRecordingArchiveSchedule = (
  input: RecordingArchiveScheduleInput,
  options: { now: number },
): RecordingArchiveSchedule => {
  const now = clock(options.now)
  const scope = snapshotMeetingScope(input.scope)
  if (!text(input.name, 200) || !text(input.destination, 4096))
    fail("archive schedule name and destination are required")
  if (typeof input.dailyAt !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.dailyAt))
    fail("archive schedule time must be HH:mm")
  if (!text(input.timeZone, 200)) fail("archive schedule requires a time zone")
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.timeZone })
  } catch {
    fail("archive schedule requires a valid IANA time zone")
  }
  recordingWindows(input.from, input.from)
  if (input.from <= day(now)) recordingWindows(input.from, day(now))
  const lookbackDays = input.lookbackDays ?? 7
  const maxBytes = input.maxBytes ?? 20 * 1024 ** 3
  if (!Number.isSafeInteger(lookbackDays) || lookbackDays < 0 || lookbackDays > 31)
    fail("archive schedule lookback must be between zero and 31 days")
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail("archive schedule byte limit must be positive")
  const definition = {
    name: input.name,
    scope,
    destination: input.destination,
    from: input.from,
    dailyAt: input.dailyAt,
    timeZone: input.timeZone,
    lookbackDays,
    maxBytes,
  }
  return Object.freeze({ version: 1, id: identity(definition), ...definition, createdAt: options.now })
}

export const parseRecordingArchiveSchedule = (value: unknown): RecordingArchiveSchedule => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid archive schedule")
  const row = value as RecordingArchiveSchedule
  if (
    Object.keys(row).some(
      (key) =>
        ![
          "version",
          "id",
          "name",
          "scope",
          "destination",
          "from",
          "dailyAt",
          "timeZone",
          "lookbackDays",
          "maxBytes",
          "createdAt",
        ].includes(key),
    ) ||
    row.version !== 1
  )
    fail("unsupported archive schedule")
  const schedule = planRecordingArchiveSchedule(row, { now: row.createdAt })
  if (schedule.id !== row.id) fail("archive schedule does not match its identity")
  return schedule
}

export const recordingArchiveScheduleWindow = (
  value: RecordingArchiveSchedule,
  options: { now: number },
): (RecordingWindow & { recheckFrom: string }) | null => {
  const schedule = parseRecordingArchiveSchedule(value)
  const now = clock(options.now)
  const through = day(now)
  if (schedule.from > through) return null
  const floor = new Date(now)
  floor.setUTCHours(0, 0, 0, 0)
  // A running job ages beyond its original ten-year discovery interval; saved pending work survives separately.
  const month = floor.getUTCMonth()
  const date = floor.getUTCDate()
  floor.setUTCDate(1)
  floor.setUTCFullYear(floor.getUTCFullYear() - 10)
  const last = new Date(floor)
  last.setUTCMonth(month + 1, 0)
  floor.setUTCDate(Math.min(date, last.getUTCDate()))
  const from = schedule.from > day(floor) ? schedule.from : day(floor)
  const overlap = new Date(`${through}T00:00:00Z`)
  overlap.setUTCDate(overlap.getUTCDate() - schedule.lookbackDays)
  const recheckFrom = from > day(overlap) ? from : day(overlap)
  return { from, to: through, recheckFrom }
}

export const installRecordingArchiveSchedule = async (
  scheduler: RecordingArchiveScheduler,
  value: RecordingArchiveSchedule,
  options: { apply?: boolean; dryRun?: boolean; signal?: AbortSignal } = {},
): Promise<{ applied: boolean; backend: string; schedule: RecordingArchiveSchedule }> => {
  const schedule = parseRecordingArchiveSchedule(value)
  const backend = scheduler.backend
  const signal = options.signal
  if (signal?.aborted) {
    if (signal.reason instanceof CliError) throw signal.reason
    const timeout = signal.reason instanceof Error && signal.reason.name === "TimeoutError"
    throw new CliError(
      timeout ? "timeout" : "cancelled",
      timeout ? "archive schedule installation timed out" : "archive schedule installation cancelled",
    )
  }
  if (options.apply !== true || options.dryRun === true) return { applied: false, backend, schedule }
  await scheduler.install(schedule, { signal })
  // An installed timer remains acknowledged if cancellation arrives after the host commits it.
  return { applied: true, backend, schedule }
}
