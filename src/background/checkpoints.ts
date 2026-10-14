import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { CliError, writeSecurely } from "@wirecat/cli-base"

/**
 * Where a long sync stopped, for a tool whose store does not already say: the cursor is the tool's own
 * (an IMAP mailbox's UIDVALIDITY and last UID, a page token), opaque to everything else.
 */
export interface Checkpoint<Cursor = unknown> {
  cursor: Cursor
  done: number
  total?: number
  updated_at: string
}

/** How far a sync is, the same in every CLI's status command. */
export interface Progress {
  job: string
  profile: string
  done: number
  total: number | null
  remaining: number | null
  state: "partial" | "complete"
  updated_at: string | null
  cursor_age_ms: number | null
}

// A profile may be an address, so `@` and `.` are allowed; a slash or `..` never reaches the path.
const PART = /^[\w@+-][\w.@+-]{0,99}$/

export const checkpointPath = (state: string, profile: string, job: string): string => {
  for (const part of [profile, job]) {
    if (!PART.test(part) || part.includes("..")) {
      throw new CliError(
        "validation_error",
        `a checkpoint is named by letters, digits, ".", "@" and "-" — not "${part}"`,
      )
    }
  }
  return join(state, "checkpoints", profile, `${job}.json`)
}

export const readCheckpoint = <Cursor = unknown>(path: string): Checkpoint<Cursor> | undefined => {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Checkpoint<Cursor>) : undefined
  } catch {
    // A torn or hand-edited file costs one sync from the start, never a failed one.
    return undefined
  }
}

/** Atomic: a kill leaves the previous checkpoint or this one, never half of each. */
export const saveCheckpoint = <Cursor>(
  path: string,
  point: { cursor: Cursor; done: number; total?: number },
  now: Date = new Date(),
): Checkpoint<Cursor> => {
  const saved: Checkpoint<Cursor> = { ...point, updated_at: now.toISOString() }
  writeSecurely(path, `${JSON.stringify(saved, null, 2)}\n`, 0o600)
  return saved
}

export const clearCheckpoint = (path: string): void => rmSync(path, { force: true })

export const progressOf = (input: {
  job: string
  profile: string
  done: number
  total?: number
  complete?: boolean
  updatedAt?: string
  now?: Date
}): Progress => {
  const total = input.total ?? null
  const updated = input.updatedAt ?? null
  return {
    job: input.job,
    profile: input.profile,
    done: input.done,
    total,
    remaining: total === null ? null : Math.max(0, total - input.done),
    state: (input.complete ?? (total !== null && input.done >= total)) ? "complete" : "partial",
    updated_at: updated,
    cursor_age_ms: updated === null ? null : Math.max(0, (input.now ?? new Date()).getTime() - Date.parse(updated)),
  }
}

const ago = (ms: number): string => {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

/** `mail personal: 234,962 of 305,550 (76%), 70,588 left — partial, updated 5m ago` */
export const progressLine = (progress: Progress): string => {
  const count = (n: number) => n.toLocaleString("en-US")
  const of =
    progress.total === null
      ? count(progress.done)
      : `${count(progress.done)} of ${count(progress.total)} (${progress.total === 0 ? 100 : Math.floor((progress.done / progress.total) * 100)}%), ${count(progress.remaining ?? 0)} left`
  const when = progress.cursor_age_ms === null ? "" : `, updated ${ago(progress.cursor_age_ms)}`
  return `${progress.job} ${progress.profile}: ${of} — ${progress.state}${when}`
}
