import type { ChannelKind, ItemType, Report, ReportItem, ReportKind, SectionKind } from "./schema.js"

/** A link the renderer built; a template may point an `href` only at one of these. Empty until deep links exist. */
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

export interface ViewSection {
  kind: SectionKind
  emoji: string
  items: ViewItem[]
  /** The "ещё N" count: what the agent left out plus what the cap or the Telegram fit dropped. */
  more: number
}

export interface ViewHealth {
  source: string
  hours: number
  span: string
  links: ViewLink[]
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
  links: ViewLink[]
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

/**
 * The view model of a checked report: sections in their fixed order, each cut to its cap with the rest counted in
 * `more`, dates and money formatted in `language` and `timeZone`. Refs never reach it.
 */
export const reportView = (
  report: Report,
  { language, now, timeZone }: { language: string; now: number; timeZone?: string },
): ReportView => {
  const moment = (iso: string | null) => (iso === null ? null : momentFor(iso, now, language, timeZone))
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
      links: [],
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
      },
    ]
  })
  const stale = report.health.filter((entry) => entry.staleHours > STALE_HOURS)
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
    sections,
    health: {
      emoji: "🛠",
      items: stale.slice(0, SECTION_CAPS.health).map((entry) => ({
        source: entry.source,
        hours: entry.staleHours,
        span: new Intl.NumberFormat(language, { style: "unit", unit: "day", unitDisplay: "long" }).format(
          Math.floor(entry.staleHours / 24),
        ),
        links: [],
      })),
      more: Math.max(stale.length - SECTION_CAPS.health, 0),
    },
    quiet: sections.length === 0,
    counts: { today: count("today"), money: count("money") },
    links: [],
  }
}
