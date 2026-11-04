import { CliError } from "@wirecat/cli-base"
import type { MeetingSearchOptions } from "./search-store.js"

/** The meetings the numbers cover: the same filters as meeting search. */
export type MeetingStatsSelection = Pick<
  MeetingSearchOptions,
  | "accountId"
  | "meetingId"
  | "eventId"
  | "meetingSeriesId"
  | "since"
  | "until"
  | "participantIdentityId"
  | "personId"
  | "projectId"
  | "tagId"
  | "signal"
>

export interface MeetingStatsInput extends MeetingStatsSelection {
  /** The zone a week starts on Monday in; UTC when not given. */
  timeZone?: string
  /** Most transcript lines to read (default 500000); more is an error, never a silent cut. */
  maxRows?: number
}

/** One transcript line as the numbers need it: who said it, when, for how long, in how many words. */
export interface MeetingStatsRow {
  meetingId: number
  startedAt: number | null
  startMs: number
  endMs: number
  words: number
  personId: number | null
  personName: string | null
  identityId: number | null
  identityName: string | null
  speakerName: string | null
}

export interface MeetingSpeakerStats {
  /** `person:<id>`, `identity:<id>`, `name:<lowercased name>` or `unknown`. */
  key: string
  name: string | null
  personId: number | null
  identityId: number | null
  meetings: number
  lines: number
  words: number
  talkMs: number
  /** This speaker's part of all talk time in the selection, 0–1. */
  share: number
}

export interface MeetingWeekStats {
  /** The Monday the week starts on, in the chosen zone: `2026-10-19`. */
  weekStart: string
  meetings: number
  talkMs: number
}

export interface MeetingStats {
  timeZone: string
  meetings: number
  lines: number
  words: number
  talkMs: number
  speakers: MeetingSpeakerStats[]
  weeks: MeetingWeekStats[]
}

export type MeetingCountsGrouping = "day" | "week" | "series"
export const MEETING_COUNTS_GROUPINGS: readonly MeetingCountsGrouping[] = ["day", "week", "series"]

export interface MeetingCountsInput extends MeetingStatsSelection {
  by: MeetingCountsGrouping
  /** The zone days and weeks are read in; UTC when not given. */
  timeZone?: string
  /** Most rows: the newest days or weeks, or the busiest series (default 100). */
  limit?: number
}

/** One selected meeting as the counts need it; no title text but the series' or the meeting's own name. */
export interface MeetingCountsMeeting {
  startedAt: number | null
  /** `duration_ms`, else `ended_at - started_at`; `null` for a meeting with no end. */
  durationMs: number | null
  transcribed: boolean
  seriesKey: string | null
  seriesTitle: string | null
}

export interface MeetingCountsRow {
  /** A day or the Monday of a week (`YYYY-MM-DD` in the zone), or `series:<external id>`, or `NO_SERIES`. */
  key: string
  /** The series title under `series`; `null` otherwise. */
  name: string | null
  meetings: number
  minutes: number
  /** Over the meetings with a duration; `null` when none has one. */
  meanMinutes: number | null
  transcripts: number
}

export interface MeetingCounts extends Omit<MeetingCountsRow, "key" | "name"> {
  by: MeetingCountsGrouping
  timeZone: string
  rows: MeetingCountsRow[]
  hasMore: boolean
}

export interface MeetingStatsStore {
  meetingStats(input: MeetingStatsInput): Promise<MeetingStats>
  meetingCounts(input: MeetingCountsInput): Promise<MeetingCounts>
}

const zoneOf = (timeZone: string | undefined): string => {
  const zone = timeZone ?? "UTC"
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone })
  } catch {
    throw new CliError("validation_error", "expected an IANA time zone such as Europe/Madrid")
  }
  return zone
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const weekStart = (at: number, format: Intl.DateTimeFormat): string => {
  const parts = Object.fromEntries(format.formatToParts(new Date(at)).map((part) => [part.type, part.value]))
  const day = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))
  return new Date(day - DAYS.indexOf(parts.weekday ?? "Mon") * 86_400_000).toISOString().slice(0, 10)
}

const dayKey = (at: number, format: Intl.DateTimeFormat): string => {
  const parts = Object.fromEntries(format.formatToParts(new Date(at)).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

const zoneFormat = (zone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  })

/** The row of meetings outside any series, under `--by series`; a constant for the same reason as `UNKNOWN_SPEAKER`. */
export const NO_SERIES = "no-series"
const MOST_COUNT_ROWS = 100

const minutesOf = (ms: number) => Math.round(ms / 60_000)
const meanOf = (ms: number, timed: number) => (timed === 0 ? null : Math.round(ms / timed / 6_000) / 10)

/**
 * Meetings, minutes and meetings with a transcript, in total and per day, week or series. A meeting with no end
 * counts in `meetings` but not in `minutes` or the mean; one with no start counts in the totals and in its series,
 * never in a day or week. Days and weeks with no meeting have no row.
 */
export const aggregateMeetingCounts = (
  meetings: readonly MeetingCountsMeeting[],
  by: MeetingCountsGrouping,
  timeZone?: string,
  limit = MOST_COUNT_ROWS,
): MeetingCounts => {
  if (!MEETING_COUNTS_GROUPINGS.includes(by))
    throw new CliError("validation_error", `--by takes ${MEETING_COUNTS_GROUPINGS.join(", ")}`)
  if (!Number.isSafeInteger(limit) || limit < 1) throw new CliError("validation_error", "--limit is a positive number")
  const zone = zoneOf(timeZone)
  const format = zoneFormat(zone)
  const sum = () => ({ meetings: 0, ms: 0, timed: 0, transcripts: 0 })
  type Sum = ReturnType<typeof sum> & { name: string | null }
  const add = (into: Sum, meeting: MeetingCountsMeeting) => {
    into.meetings += 1
    if (meeting.durationMs !== null) {
      into.ms += Math.max(0, meeting.durationMs)
      into.timed += 1
    }
    if (meeting.transcribed) into.transcripts += 1
  }
  const total: Sum = { ...sum(), name: null }
  const groups = new Map<string, Sum>()
  for (const meeting of meetings) {
    add(total, meeting)
    const key =
      by === "series"
        ? meeting.seriesKey === null
          ? NO_SERIES
          : `series:${meeting.seriesKey}`
        : meeting.startedAt === null
          ? null
          : by === "day"
            ? dayKey(meeting.startedAt, format)
            : weekStart(meeting.startedAt, format)
    if (key === null) continue
    const group = groups.get(key) ?? { ...sum(), name: by === "series" ? meeting.seriesTitle : null }
    add(group, meeting)
    groups.set(key, group)
  }
  const ordered = [...groups.entries()].sort(([a, one], [b, other]) =>
    by === "series" ? other.ms - one.ms || other.meetings - one.meetings || a.localeCompare(b) : b.localeCompare(a),
  )
  const kept = ordered.slice(0, limit)
  if (by !== "series") kept.reverse()
  const counted = ({ meetings: count, ms, timed, transcripts }: Sum) => ({
    meetings: count,
    minutes: minutesOf(ms),
    meanMinutes: meanOf(ms, timed),
    transcripts,
  })
  return {
    by,
    timeZone: zone,
    ...counted(total),
    rows: kept.map(([key, group]) => ({ key, name: group.name, ...counted(group) })),
    hasMore: ordered.length > limit,
  }
}

/** Lines with no speaker at all; a constant, since a `key: "…"` literal reads as a permission key to the key test. */
const UNKNOWN_SPEAKER = "unknown"
const speakerOf = (row: MeetingStatsRow) =>
  row.personId !== null
    ? { key: `person:${row.personId}`, name: row.personName ?? row.identityName ?? row.speakerName }
    : row.identityId !== null
      ? { key: `identity:${row.identityId}`, name: row.identityName ?? row.speakerName }
      : row.speakerName?.trim()
        ? { key: `name:${row.speakerName.trim().toLowerCase()}`, name: row.speakerName.trim() }
        : { key: UNKNOWN_SPEAKER, name: null }

/**
 * Talk time, lines and words per speaker, and meetings and talk time per week. A speaker is a linked person when the
 * line's participant has one, else the participant's identity, else the name the transcript gives; lines with none
 * are `unknown`. Talk time is each line's end less its start, so overlapping speech counts for everyone speaking.
 */
export const aggregateMeetingStats = (rows: readonly MeetingStatsRow[], timeZone?: string): MeetingStats => {
  const zone = zoneOf(timeZone)
  const format = zoneFormat(zone)
  const speakers = new Map<string, MeetingSpeakerStats & { seen: Set<number> }>()
  const weeks = new Map<string, { meetings: Set<number>; talkMs: number }>()
  const meetings = new Set<number>()
  let lines = 0
  let words = 0
  let talkMs = 0
  for (const row of rows) {
    const talk = Math.max(0, row.endMs - row.startMs)
    meetings.add(row.meetingId)
    lines += 1
    words += row.words
    talkMs += talk
    const who = speakerOf(row)
    const held = speakers.get(who.key) ?? {
      key: who.key,
      name: who.name ?? null,
      personId: row.personId,
      identityId: row.personId === null ? row.identityId : null,
      meetings: 0,
      lines: 0,
      words: 0,
      talkMs: 0,
      share: 0,
      seen: new Set<number>(),
    }
    held.seen.add(row.meetingId)
    held.lines += 1
    held.words += row.words
    held.talkMs += talk
    speakers.set(who.key, held)
    if (row.startedAt !== null) {
      const week = weeks.get(weekStart(row.startedAt, format)) ?? { meetings: new Set<number>(), talkMs: 0 }
      week.meetings.add(row.meetingId)
      week.talkMs += talk
      weeks.set(weekStart(row.startedAt, format), week)
    }
  }
  return {
    timeZone: zone,
    meetings: meetings.size,
    lines,
    words,
    talkMs,
    speakers: [...speakers.values()]
      .map(({ seen, ...speaker }) => ({
        ...speaker,
        meetings: seen.size,
        share: talkMs === 0 ? 0 : Math.round((speaker.talkMs / talkMs) * 1000) / 1000,
      }))
      .sort((a, b) => b.talkMs - a.talkMs || a.key.localeCompare(b.key)),
    weeks: [...weeks.entries()]
      .map(([start, week]) => ({ weekStart: start, meetings: week.meetings.size, talkMs: week.talkMs }))
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
  }
}
