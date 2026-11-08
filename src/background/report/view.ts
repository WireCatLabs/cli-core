import { refsForLink } from "../../domain/links.js"
import type { ChannelKind, HealthReason, ItemType, Report, ReportItem, ReportKind, SectionKind } from "./schema.js"

/** A link the renderer built from a ref; a template may point an `href` only at one of these. */
export interface ViewLink {
  kind: "open" | "web"
  url: string
  label: string
}

/** A date or a date-time, already in the owner's language and time zone. */
export interface Moment {
  iso: string
  /** "7 ноября", "November 7". */
  date: string
  /** "18:00", or null for a date alone. */
  time: string | null
  /** 1 Monday … 7 Sunday. */
  weekday: number
  day: "today" | "yesterday" | "tomorrow" | null
  past: boolean
  /** How far from now, in the largest whole unit: "10 минут", "5 часов", "2 дня". */
  span: string
}

export interface ViewItem {
  type: ItemType
  emoji: string
  who: string | null
  topic: string | null
  action: string | null
  detail: string | null
  quote: string | null
  channel: ChannelKind | null
  priority: "high" | "normal"
  overdue: boolean
  count: number | null
  amount: { text: string; direction: "in" | "out" } | null
  since: Moment | null
  due: Moment | null
  time: Moment | null
  links: ViewLink[]
}

export interface ViewTaskGroup {
  filter: "overdue" | "today" | "tomorrow" | "new"
  count: number
  /** `tasks/<filter>`; null when links are off, or `new` has no time to count from. */
  link: ViewLink | null
}

export interface ViewSection {
  kind: SectionKind
  emoji: string
  items: ViewItem[]
  /** The "ещё N" count: what the agent left out plus what the cap or the Telegram fit dropped. */
  more: number
  /** The task group links, on the section that holds the task items only; zero groups left out. */
  groups: ViewTaskGroup[]
  /** The open tasks with no due date, a line after the groups on the same section; null when there are none. */
  undated: { count: number; link: ViewLink | null } | null
}

export interface ViewHealth {
  source: string
  account: string | null
  reason: HealthReason | null
  since: Moment | null
  hours: number
  span: string
  links: ViewLink[]
}

/** The footer line: a template picks a word's form by `plural` (`Intl.PluralRules`: one, few, many, other). */
export interface ViewScope {
  /** "24 ч", "3 дня": hours below two days or for a part of a day, else days. */
  window: string
  sources: { kind: ChannelKind; accounts: number; plural: string }[]
  /** Zero counts left out, in the order chats, mail, tasks, meetings. */
  counts: { kind: "chats" | "mail" | "tasks" | "meetings"; count: number; plural: string }[]
}

/** What a report template gets. Every string an agent wrote is already escaped for an HTML channel. */
export interface ReportView {
  kind: ReportKind
  language: string
  emoji: string
  date: Moment
  summary: string | null
  sections: ViewSection[]
  health: { emoji: string; items: ViewHealth[]; more: number }
  /** Nothing in the six sections: the template says so, and says a stale source if there is one. */
  quiet: boolean
  counts: { today: number; money: number }
  scope: ViewScope | null
  links: ViewLink[]
}

/** Builds the URL a ref opens, or null; the renderer passes `linkFor` with the form its channel needs. */
export type LinkOf = (ref: string) => string | null

const LINK_WORDS: Record<string, { open: string; fix: string }> = {
  ru: { open: "открыть", fix: "исправить" },
  en: { open: "open", fix: "fix" },
}

export const SECTION_EMOJI: Record<SectionKind, string> = {
  today: "🔥",
  decisions: "🗳",
  money: "💰",
  meetings: "📅",
  projects: "🚀",
  mail: "📬",
}
export const SECTION_CAPS: Record<SectionKind | "health", number> = {
  today: 7,
  decisions: 5,
  money: 5,
  meetings: 5,
  projects: 5,
  mail: 5,
  health: 3,
}
const STALE_HOURS = 24
const HOUR_MS = 3_600_000

const emojiOf = (item: ReportItem, overdue: boolean): string => {
  switch (item.type) {
    case "reply":
      return "💬"
    case "question":
      return "❓"
    case "task":
      return overdue ? "⏰" : "📌"
    case "fact":
      return "ℹ️"
    case "risk":
      return item.priority === "high" ? "🔴" : "⚠️"
    case "money":
      return item.amount?.direction === "in" ? "📥" : "📤"
    case "decision":
      return "☑️"
    case "meeting":
      return "👥"
  }
}

const DAY_MS = 86_400_000

const calendarDay = (at: number, timeZone: string | undefined): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at)

const utcOf = (day: string) => {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number)
  return Date.UTC(year, month - 1, date)
}

export const momentFor = (iso: string, now: number, language: string, timeZone?: string): Moment => {
  const dateOnly = iso.length === 10
  const at = dateOnly ? utcOf(iso) : Date.parse(iso)
  const day = dateOnly ? iso : calendarDay(at, timeZone)
  const days = Math.round((utcOf(day) - utcOf(calendarDay(now, timeZone))) / DAY_MS)
  const unit = (count: number, name: "minute" | "hour" | "day") =>
    new Intl.NumberFormat(language, { style: "unit", unit: name, unitDisplay: "long" }).format(count)
  const distance = Math.abs(at - now)
  const span = dateOnly
    ? unit(Math.abs(days), "day")
    : distance < 3_600_000
      ? unit(Math.floor(distance / 60_000), "minute")
      : distance < DAY_MS
        ? unit(Math.floor(distance / 3_600_000), "hour")
        : unit(Math.floor(distance / DAY_MS), "day")
  return {
    iso,
    date: new Intl.DateTimeFormat(language, { day: "numeric", month: "long", timeZone: "UTC" }).format(utcOf(day)),
    time: dateOnly
      ? null
      : new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(
          at,
        ),
    weekday: ((new Date(utcOf(day)).getUTCDay() + 6) % 7) + 1,
    day: days === 0 ? "today" : days === -1 ? "yesterday" : days === 1 ? "tomorrow" : null,
    past: dateOnly ? days < 0 : at < now,
    span,
  }
}

const amountText = (amount: NonNullable<ReportItem["amount"]>, language: string) => {
  const fraction = Number.isInteger(amount.value) ? 0 : 2
  const money = new Intl.NumberFormat(language, {
    style: "currency",
    currency: amount.currency,
    minimumFractionDigits: fraction,
    maximumFractionDigits: fraction,
  }).format(amount.value)
  return `${amount.direction === "in" ? "+" : "−"}${money}`
}

const taskGroups = (tasks: Report["tasks"], linkOf: LinkOf, label: string): ViewTaskGroup[] => {
  if (!tasks) return []
  const groups: { filter: ViewTaskGroup["filter"]; count: number; ref: string | null }[] = [
    { filter: "overdue", count: tasks.overdue, ref: "tasks:overdue" },
    { filter: "today", count: tasks.today, ref: "tasks:today" },
    { filter: "tomorrow", count: tasks.tomorrow, ref: "tasks:tomorrow" },
    {
      filter: "new",
      count: tasks.new,
      ref: tasks.newSince === null ? null : `tasks:new/${encodeURIComponent(tasks.newSince)}`,
    },
  ]
  return groups
    .filter((group) => group.count > 0)
    .map(({ filter, count, ref }) => {
      const url = ref === null ? null : linkOf(ref)
      return { filter, count, link: url === null ? null : { kind: "open", url, label } }
    })
}

const scopeView = (scope: NonNullable<Report["scope"]>, language: string): ViewScope => {
  const plural = new Intl.PluralRules(language)
  const hours = Math.round((Date.parse(scope.to) - Date.parse(scope.from)) / HOUR_MS)
  const window =
    hours >= 48 && hours % 24 === 0
      ? new Intl.NumberFormat(language, { style: "unit", unit: "day", unitDisplay: "long" }).format(hours / 24)
      : new Intl.NumberFormat(language, { style: "unit", unit: "hour", unitDisplay: "short" }).format(hours)
  const counts = (["chats", "mail", "tasks", "meetings"] as const)
    .map((kind) => ({ kind, count: scope.counts[kind], plural: plural.select(scope.counts[kind]) }))
    .filter((one) => one.count > 0)
  return {
    window,
    sources: scope.sources.map((source) => ({ ...source, plural: plural.select(source.accounts) })),
    counts,
  }
}

/**
 * The view model of a checked report: sections in their fixed order, each cut to its cap with the rest counted in
 * `more`, dates and money formatted in `language` and `timeZone`. Refs never reach it.
 */
export const reportView = (
  report: Report,
  {
    language,
    now,
    timeZone,
    linkOf = () => null,
  }: { language: string; now: number; timeZone?: string; linkOf?: LinkOf },
): ReportView => {
  const moment = (iso: string | null) => (iso === null ? null : momentFor(iso, now, language, timeZone))
  const words = LINK_WORDS[language] ?? (LINK_WORDS.en as { open: string; fix: string })
  const linksOf = (refs: readonly string[], label: string): ViewLink[] => {
    const url = refsForLink(refs)
      .map(linkOf)
      .find((one) => one !== null)
    return url ? [{ kind: "open", url, label }] : []
  }
  const itemOf = (item: ReportItem): ViewItem => {
    const due = moment(item.due)
    const overdue = (item.type === "task" || item.type === "money" || item.type === "risk") && due?.past === true
    return {
      type: item.type,
      emoji: emojiOf(item, overdue),
      who: item.who,
      topic: item.topic,
      action: item.action,
      detail: item.detail,
      quote: item.quote,
      channel: item.channel,
      priority: item.priority,
      overdue,
      count: item.count,
      amount: item.amount ? { text: amountText(item.amount, language), direction: item.amount.direction } : null,
      since: moment(item.since),
      due,
      time: moment(item.time),
      links: linksOf(item.refs, words.open),
    }
  }
  const order = Object.keys(SECTION_EMOJI) as SectionKind[]
  const sections = order.flatMap((kind): ViewSection[] => {
    const parts = report.sections.filter((section) => section.kind === kind)
    const items = parts.flatMap((section) => section.items)
    const more = parts.reduce((sum, section) => sum + section.more, 0)
    if (items.length === 0) return []
    const cap = SECTION_CAPS[kind]
    return [
      {
        kind,
        emoji: SECTION_EMOJI[kind],
        items: items.slice(0, cap).map(itemOf),
        more: more + Math.max(items.length - cap, 0),
        groups: [],
        undated: null,
      },
    ]
  })
  const groups = taskGroups(report.tasks, linkOf, words.open)
  const undatedLink = linkOf("tasks:undated")
  const undated = report.tasks?.undated
    ? {
        count: report.tasks.undated,
        link: undatedLink === null ? null : { kind: "open" as const, url: undatedLink, label: words.open },
      }
    : null
  const holder =
    sections.find((section) => section.items.some((item) => item.type === "task")) ??
    sections.find((section) => section.kind === "today") ??
    sections.at(-1)
  const stale = report.health.filter((entry) => entry.reason !== null || entry.staleHours > STALE_HOURS)
  const count = (kind: SectionKind) => {
    const section = sections.find((one) => one.kind === kind)
    return section ? section.items.length + section.more : 0
  }
  return {
    kind: report.kind,
    language,
    emoji: "☀️",
    date: momentFor(report.date, now, language, timeZone),
    summary: report.summary,
    sections: sections.map((section) => (section === holder ? { ...section, groups, undated } : section)),
    health: {
      emoji: "🛠",
      items: stale.slice(0, SECTION_CAPS.health).map((entry) => ({
        source: entry.source,
        account: entry.account,
        reason: entry.reason,
        since: moment(entry.since),
        hours: entry.staleHours,
        span: new Intl.NumberFormat(language, { style: "unit", unit: "day", unitDisplay: "long" }).format(
          Math.floor(entry.staleHours / 24),
        ),
        links: linksOf(entry.refs, words.fix),
      })),
      more: Math.max(stale.length - SECTION_CAPS.health, 0),
    },
    quiet: sections.length === 0,
    counts: { today: count("today"), money: count("money") },
    scope: report.scope && scopeView(report.scope, language),
    links: [],
  }
}
