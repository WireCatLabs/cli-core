import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { jsonOfAnswer, REPORT_FORMAT, type ReportKind, withoutLeaks } from "./schema.js"
import { type LinkOf, type Moment, momentFor, type ViewLink } from "./view.js"

/** Every message WireCat renders for the owner: the digest, the weekly gaps, and a failed schedule's notice. */
export type MessageKind = ReportKind | "weekly-gaps" | "schedule-failed"

/** What one digest run found that its agenda had not shown, as the agent wrote it in `internal.gaps`. */
export interface Gap {
  what: string
  /** The agenda section it belonged in (`owed`, `mail`…), or null. */
  section: string | null
  refs: string[]
}

/** A `wirecat.report/1` document of kind `weekly-gaps`: the gaps of a week of digests, each said once. */
export interface WeeklyGaps {
  kind: "weekly-gaps"
  from: string
  to: string
  /** The digests the week had. */
  runs: number
  gaps: (Gap & { seen: number; first: string; last: string })[]
}

const WHAT_LIMIT = 160
const SECTION = /^[a-z][a-z-]{0,23}$/
const DAY_MS = 86_400_000

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const cut = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`)

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : []

/**
 * The gaps a digest's answer kept in `internal.gaps`, or none. `internal` is the agent's note to itself, so a gap
 * that is not `{ what, refs | ref, section }` is left out rather than failing anything; `what` loses its leaks.
 */
export const gapsOfAnswer = (answer: string): Gap[] | undefined => {
  const json = jsonOfAnswer(answer)
  if (json === undefined) return undefined
  let document: unknown
  try {
    document = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!isObject(document) || document.format !== REPORT_FORMAT || document.kind !== "morning-digest") return undefined
  const gaps = isObject(document.internal) ? document.internal.gaps : undefined
  return (Array.isArray(gaps) ? gaps : []).flatMap((gap): Gap[] => {
    if (!isObject(gap) || typeof gap.what !== "string") return []
    const what = withoutLeaks(gap.what.trim()).text
    if (!what) return []
    return [
      {
        what: cut(what, WHAT_LIMIT),
        section: typeof gap.section === "string" && SECTION.test(gap.section) ? gap.section : null,
        refs: [...new Set([...stringsOf(gap.refs), ...(typeof gap.ref === "string" ? [gap.ref] : [])])],
      },
    ]
  })
}

/** A run file's time from its name, `2026-11-08T08-30-00Z.md`; NaN for any other file. */
const runTime = (file: string): number => {
  const [, day, hour, minute, second] = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.md$/.exec(file) ?? []
  return day ? Date.parse(`${day}T${hour}:${minute}:${second}Z`) : Number.NaN
}

const sameText = (text: string) =>
  text
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim()

/**
 * The gaps of the digest runs in `runs` from the last `days` days, oldest run first. One gap that several runs
 * found is said once: two gaps are the same when they share a ref, or their words differ only in case and
 * punctuation. The newest wording is kept; the ones seen most often come first.
 */
export const weeklyGapsOf = (runs: string, now: number, days = 7): WeeklyGaps => {
  const from = now - days * DAY_MS
  const files = existsSync(runs)
    ? readdirSync(runs)
        .map((file) => ({ file, at: runTime(file) }))
        .filter(({ at }) => at > from && at <= now)
        .sort((a, b) => a.at - b.at)
    : []
  const groups: { gap: Gap; texts: Set<string>; refs: Set<string>; seen: Set<number>; first: number; last: number }[] =
    []
  let digests = 0
  for (const { file, at } of files) {
    const gaps = gapsOfAnswer(readFileSync(join(runs, file), "utf8"))
    if (gaps === undefined) continue
    digests++
    for (const gap of gaps) {
      const text = sameText(gap.what)
      const group = groups.find((one) => one.texts.has(text) || gap.refs.some((ref) => one.refs.has(ref)))
      if (!group) {
        groups.push({ gap, texts: new Set([text]), refs: new Set(gap.refs), seen: new Set([at]), first: at, last: at })
        continue
      }
      group.texts.add(text)
      for (const ref of gap.refs) group.refs.add(ref)
      group.seen.add(at)
      group.last = at
      group.gap = { what: gap.what, section: gap.section ?? group.gap.section, refs: [...group.refs] }
    }
  }
  return {
    kind: "weekly-gaps",
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    runs: digests,
    gaps: groups
      .sort((a, b) => b.seen.size - a.seen.size || b.last - a.last)
      .map(({ gap, refs, seen, first, last }) => ({
        ...gap,
        refs: [...refs],
        seen: seen.size,
        first: new Date(first).toISOString(),
        last: new Date(last).toISOString(),
      })),
  }
}

class Invalid extends Error {}

const moment = (value: unknown, at: string): string => {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Invalid(at)
  return value
}

const count = (value: unknown, at: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Invalid(at)
  return value
}

/** A weekly-gaps document as JSON, checked: the shipped sample, or one a test wrote. */
export const parseWeeklyGaps = (json: string): WeeklyGaps => {
  const document: unknown = JSON.parse(json)
  if (!isObject(document) || document.format !== REPORT_FORMAT || document.kind !== "weekly-gaps")
    throw new Invalid("kind")
  if (!Array.isArray(document.gaps)) throw new Invalid("gaps")
  return {
    kind: "weekly-gaps",
    from: moment(document.from, "from"),
    to: moment(document.to, "to"),
    runs: count(document.runs, "runs"),
    gaps: document.gaps.map((gap, g) => {
      if (!isObject(gap) || typeof gap.what !== "string") throw new Invalid(`gaps[${g}].what`)
      return {
        what: cut(withoutLeaks(gap.what).text, WHAT_LIMIT),
        section: typeof gap.section === "string" && SECTION.test(gap.section) ? gap.section : null,
        refs: stringsOf(gap.refs),
        seen: count(gap.seen, `gaps[${g}].seen`),
        first: moment(gap.first, `gaps[${g}].first`),
        last: moment(gap.last, `gaps[${g}].last`),
      }
    }),
  }
}

/** The document as `<run>.report.json`-style JSON, refs kept for Desktop. */
export const weeklyGapsDocument = (gaps: WeeklyGaps): Record<string, unknown> => ({ format: REPORT_FORMAT, ...gaps })

/** Why a scheduled run failed, as a word a template turns into the owner's language. */
export const FAILURE_CAUSES = ["locked", "sign-in", "network", "provider", "setup", "stopped", "crashed"] as const
export type FailureCause = (typeof FAILURE_CAUSES)[number]

const CAUSE_OF_CODE: Record<string, FailureCause> = {
  authentication_error: "sign-in",
  network_error: "network",
  provider_unavailable: "network",
  timeout: "network",
  rate_limited: "network",
  provider_error: "provider",
  invalid_response: "provider",
  outcome_unknown: "provider",
  configuration_error: "setup",
  permission_error: "setup",
  not_found: "setup",
  validation_error: "setup",
  conflict: "setup",
  confirmation_required: "setup",
  cancelled: "stopped",
}

/** The cause of a failed run from its error code, else its exit code: killed (137, 143) is stopped. */
export const causeOf = (errorCode: string | undefined, exitCode: number): FailureCause =>
  (errorCode === undefined ? undefined : CAUSE_OF_CODE[errorCode]) ??
  (exitCode === 137 || exitCode === 143 ? "stopped" : "crashed")

/** A scheduled run that failed: the notice `notice/schedule-failed` renders. */
export interface ScheduleFailure {
  kind: "schedule-failed"
  /** The CLI the schedule belongs to: `memo`, `tg`. */
  tool: string
  schedule: string
  at: string
  /** The first failure of the ones in a row. */
  since: string
  failures: number
  cause: FailureCause
  /** The one "fix" link: the tool's sync screen. */
  refs: string[]
}

export const parseScheduleFailure = (json: string): ScheduleFailure => {
  const document: unknown = JSON.parse(json)
  if (!isObject(document) || document.kind !== "schedule-failed") throw new Invalid("kind")
  if (typeof document.tool !== "string" || typeof document.schedule !== "string") throw new Invalid("schedule")
  if (!(FAILURE_CAUSES as readonly unknown[]).includes(document.cause)) throw new Invalid("cause")
  return {
    kind: "schedule-failed",
    tool: document.tool,
    schedule: document.schedule,
    at: moment(document.at, "at"),
    since: moment(document.since, "since"),
    failures: count(document.failures, "failures"),
    cause: document.cause as FailureCause,
    refs: stringsOf(document.refs),
  }
}

const LINK_WORDS: Record<string, { open: string; fix: string }> = {
  ru: { open: "открыть", fix: "исправить" },
  en: { open: "open", fix: "fix" },
}
const wordsOf = (language: string) => LINK_WORDS[language] ?? (LINK_WORDS.en as { open: string; fix: string })

const linkOfRefs = (refs: readonly string[], linkOf: LinkOf, label: string): ViewLink[] => {
  const url = refs.map(linkOf).find((one) => one !== null)
  return url ? [{ kind: "open", url, label }] : []
}

export const GAPS_CAP = 15

export interface ViewGap {
  what: string
  section: string | null
  /** In how many of the week's digests it came up; `plural` picks the word's form (`Intl.PluralRules`). */
  seen: number
  plural: string
  first: Moment
  last: Moment
  links: ViewLink[]
}

/** What a `report/weekly-gaps` template gets. */
export interface GapsView {
  kind: "weekly-gaps"
  language: string
  from: Moment
  to: Moment
  runs: number
  plural: string
  items: ViewGap[]
  /** Gaps past the cap, or dropped to fit Telegram. */
  more: number
  links: ViewLink[]
}

export const gapsView = (
  gaps: WeeklyGaps,
  {
    language,
    now,
    timeZone,
    linkOf = () => null,
  }: { language: string; now: number; timeZone?: string; linkOf?: LinkOf },
): GapsView => {
  const plural = new Intl.PluralRules(language)
  const at = (iso: string) => momentFor(iso, now, language, timeZone)
  const label = wordsOf(language).open
  return {
    kind: "weekly-gaps",
    language,
    from: at(gaps.from),
    to: at(gaps.to),
    runs: gaps.runs,
    plural: plural.select(gaps.runs),
    items: gaps.gaps.slice(0, GAPS_CAP).map((gap) => ({
      what: gap.what,
      section: gap.section,
      seen: gap.seen,
      plural: plural.select(gap.seen),
      first: at(gap.first),
      last: at(gap.last),
      links: linkOfRefs(gap.refs, linkOf, label),
    })),
    more: Math.max(gaps.gaps.length - GAPS_CAP, 0),
    links: [],
  }
}

/** What a `notice/schedule-failed` template gets. */
export interface NoticeView {
  kind: "schedule-failed"
  language: string
  tool: string
  schedule: string
  at: Moment
  since: Moment
  failures: number
  plural: string
  cause: FailureCause
  links: ViewLink[]
}

export const noticeView = (
  failure: ScheduleFailure,
  {
    language,
    now,
    timeZone,
    linkOf = () => null,
  }: { language: string; now: number; timeZone?: string; linkOf?: LinkOf },
): NoticeView => ({
  kind: "schedule-failed",
  language,
  tool: failure.tool,
  schedule: failure.schedule,
  at: momentFor(failure.at, now, language, timeZone),
  since: momentFor(failure.since, now, language, timeZone),
  failures: failure.failures,
  plural: new Intl.PluralRules(language).select(failure.failures),
  cause: failure.cause,
  links: linkOfRefs(failure.refs, linkOf, wordsOf(language).fix),
})
