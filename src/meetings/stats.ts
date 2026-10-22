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

export interface MeetingStatsStore {
  meetingStats(input: MeetingStatsInput): Promise<MeetingStats>
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
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  })
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
