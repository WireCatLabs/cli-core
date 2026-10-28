import { createHash } from "node:crypto"
import type { MailRule } from "./rules.js"

/** Inclusive UID stretches, sorted and apart: a mailbox read newest first in batches stays a few stretches. */
export type Ranges = [number, number][]

/** Where a folder's listing stopped, kept in the store beside the mail it describes, so a restored backup agrees. */
export interface ResumePoint {
  validity: string
  done: Ranges
  /** The rules the done mail was decided under; other rules decide it again. */
  rules: string
  /**
   * The widest recent listing of every message, the only kind that proves deletions and refreshes labels and
   * flags: a later run whose window it covers may list only what is not done.
   */
  full: { since: string; at: string }
  /** The widest window searched: its messages, and how many of them are done; a narrower run leaves it. */
  window: { since: string; total: number; done: number }
  /**
   * The widest window ever listed, kept across a rule change, a new UIDVALIDITY or --rescan, which start `window`
   * over: a timer's 30 days must never stand in for a mailbox read since 2004.
   */
  widest?: { since: string; total: number; at: string }
  /** What the latest run listed, whatever its window. */
  last?: { since: string; total: number; done: number; at: string }
  updatedAt: string
}

/** A whole listing at least this often, so deletions, labels and read state are never more than a day old. */
export const FULL_PASS_MS = 86_400_000

export const resumeKey = (folder: string): string => `mail_resume:${folder}`

/** An mbox file has no UIDs: an unchanged file read to the end has nothing new. */
export const MBOX_RESUME = "mail_resume:mbox"

export interface FileStamp {
  size: number
  mtimeMs: number
}

export interface MboxPoint extends FileStamp {
  /** Every email of the file was read: a run cut short by --limit reads it again. */
  complete: boolean
  updatedAt: string
}

export const rangesOf = (values: Iterable<number>): Ranges => {
  const sorted = [...new Set(values)].sort((a, b) => a - b)
  const ranges: Ranges = []
  for (const value of sorted) {
    const last = ranges.at(-1)
    if (last !== undefined && value === last[1] + 1) last[1] = value
    else ranges.push([value, value])
  }
  return ranges
}

export const mergeRanges = (a: Ranges, b: Ranges): Ranges => {
  const merged: Ranges = []
  for (const [from, to] of [...a, ...b].sort(([x], [y]) => x - y)) {
    const last = merged.at(-1)
    if (last !== undefined && from <= last[1] + 1) last[1] = Math.max(last[1], to)
    else merged.push([from, to])
  }
  return merged
}

export const within = (ranges: Ranges, value: number): boolean => {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const [from, to] = ranges[middle] as [number, number]
    if (value < from) high = middle - 1
    else if (value > to) low = middle + 1
    else return true
  }
  return false
}

/** Only what decides mail: a changed reason or date is the same rule. */
export const rulesKey = (rules: readonly MailRule[]): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        rules
          .map(({ match, action }) =>
            JSON.stringify([action, match.from ?? null, match.domain ?? null, match.list_id ?? null]),
          )
          .sort(),
      ),
    )
    .digest("hex")
    .slice(0, 16)

export const parsePoint = <T>(value: string | undefined): T | undefined => {
  if (value === undefined) return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}
