export const REPORT_FORMAT = "wirecat.report/1"
export const REPORT_KINDS = ["morning-digest"] as const
export type ReportKind = (typeof REPORT_KINDS)[number]

/** In the order they are shown; `health` is not among them, it comes from the document's `health[]` only. */
export const SECTION_KINDS = ["today", "decisions", "money", "meetings", "projects", "mail"] as const
export type SectionKind = (typeof SECTION_KINDS)[number]

export const ITEM_TYPES = ["reply", "question", "task", "fact", "risk", "money", "decision", "meeting"] as const
export type ItemType = (typeof ITEM_TYPES)[number]

export const CHANNEL_KINDS = ["telegram", "max", "whatsapp", "mail", "meeting", "task"] as const
export type ChannelKind = (typeof CHANNEL_KINDS)[number]

export interface Amount {
  value: number
  currency: string
  direction: "in" | "out"
}

export interface ReportItem {
  type: ItemType
  who: string | null
  topic: string | null
  action: string | null
  detail: string | null
  quote: string | null
  since: string | null
  due: string | null
  time: string | null
  amount: Amount | null
  count: number | null
  priority: "high" | "normal"
  channel: ChannelKind | null
  refs: string[]
}

export interface ReportSection {
  kind: SectionKind
  items: ReportItem[]
  more: number
}

export interface HealthEntry {
  source: string
  staleHours: number
  refs: string[]
}

/** A `wirecat.report/1` document as the renderers read it: checked, cut to its limits, with no `links` or `internal`. */
export interface Report {
  kind: ReportKind
  date: string
  summary: string | null
  sections: ReportSection[]
  health: HealthEntry[]
}

const TEXT_LIMITS = { summary: 120, who: 80, topic: 60, action: 120, detail: 160, quote: 100, source: 40 } as const
type TextField = keyof typeof TEXT_LIMITS

const REQUIRED: Record<ItemType, readonly (keyof ReportItem)[]> = {
  reply: ["who", "topic", "action", "since"],
  question: ["who", "topic", "action"],
  task: ["topic", "due"],
  fact: ["topic", "detail"],
  risk: ["topic", "detail", "action"],
  money: ["who", "topic", "amount"],
  decision: ["topic", "action"],
  meeting: ["topic", "time"],
}

const LEAKS = [
  /\b[a-z]+:[a-z]+\/\S+/g,
  /`+/g,
  /(?<![\p{L}\p{N}])--[a-z][a-z0-9-]*/gu,
  /(?<![\p{L}\p{N}_])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\p{L}\p{N}_])/gu,
]

/** What a leak pattern removed from agent text: a store reference, backticks, a `--flag` or a snake_case word. */
export const withoutLeaks = (text: string): { text: string; leaks: number } => {
  let leaks = 0
  let out = text
  for (const pattern of LEAKS)
    out = out.replace(pattern, () => {
      leaks++
      return ""
    })
  return { text: leaks ? out.replace(/\s{2,}/g, " ").trim() : out, leaks }
}

class Invalid extends Error {}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const oneOf = <T extends string>(values: readonly T[], value: unknown, at: string): T => {
  if (!values.includes(value as T)) throw new Invalid(at)
  return value as T
}

const whole = (value: unknown, at: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Invalid(at)
  return value
}

const refsOf = (value: unknown, at: string): string[] => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((one) => typeof one !== "string")) throw new Invalid(at)
  return value as string[]
}

const momentOf = (value: unknown, at: string): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== "string" || !(DATE.test(value) || DATE_TIME.test(value)) || Number.isNaN(Date.parse(value)))
    throw new Invalid(at)
  return value
}

const amountOf = (value: unknown, at: string): Amount | null => {
  if (value === undefined || value === null) return null
  if (
    !isObject(value) ||
    typeof value.value !== "number" ||
    !Number.isFinite(value.value) ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.currency)
  )
    throw new Invalid(at)
  return {
    value: Math.abs(value.value),
    currency: value.currency,
    direction: oneOf(["in", "out"], value.direction, `${at}.direction`),
  }
}

const cut = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`)

/**
 * Checks a parsed document and keeps what the renderers may show. Any agent string loses what `withoutLeaks` finds
 * and is cut to its limit; a required field left empty by that makes the document invalid, as a missing one does.
 */
const checked = (document: unknown): { report: Report; leaks: number } => {
  let leaks = 0
  const text = (value: unknown, field: TextField, at: string): string | null => {
    if (value === undefined || value === null) return null
    if (typeof value !== "string") throw new Invalid(at)
    const clean = withoutLeaks(value.trim())
    leaks += clean.leaks
    return clean.text ? cut(clean.text, TEXT_LIMITS[field]) : null
  }
  if (!isObject(document)) throw new Invalid("document")
  if (document.format !== REPORT_FORMAT) throw new Invalid("format")
  const kind = oneOf(REPORT_KINDS, document.kind, "kind")
  if (typeof document.date !== "string" || !DATE.test(document.date) || Number.isNaN(Date.parse(document.date)))
    throw new Invalid("date")
  if (!Array.isArray(document.sections)) throw new Invalid("sections")
  const sections = document.sections.map((section, s): ReportSection => {
    const at = `sections[${s}]`
    if (!isObject(section) || !Array.isArray(section.items)) throw new Invalid(at)
    return {
      kind: oneOf(SECTION_KINDS, section.kind, `${at}.kind`),
      more: section.more === undefined || section.more === null ? 0 : whole(section.more, `${at}.more`),
      items: section.items.map((item, i): ReportItem => {
        const where = `${at}.items[${i}]`
        if (!isObject(item)) throw new Invalid(where)
        const type = oneOf(ITEM_TYPES, item.type, `${where}.type`)
        const checkedItem: ReportItem = {
          type,
          who: text(item.who, "who", `${where}.who`),
          topic: text(item.topic, "topic", `${where}.topic`),
          action: text(item.action, "action", `${where}.action`),
          detail: text(item.detail, "detail", `${where}.detail`),
          quote: text(item.quote, "quote", `${where}.quote`),
          since: momentOf(item.since, `${where}.since`),
          due: momentOf(item.due, `${where}.due`),
          time: momentOf(item.time, `${where}.time`),
          amount: amountOf(item.amount, `${where}.amount`),
          count: item.count === undefined || item.count === null ? null : whole(item.count, `${where}.count`),
          priority:
            item.priority === undefined || item.priority === null
              ? "normal"
              : oneOf(["high", "normal"], item.priority, `${where}.priority`),
          channel:
            item.channel === undefined || item.channel === null
              ? null
              : oneOf(CHANNEL_KINDS, item.channel, `${where}.channel`),
          refs: refsOf(item.refs, `${where}.refs`),
        }
        const missing = REQUIRED[type].find((field) => checkedItem[field] === null)
        if (missing) throw new Invalid(`${where}.${missing}`)
        return checkedItem
      }),
    }
  })
  const health = (document.health === undefined || document.health === null ? [] : document.health) as unknown
  if (!Array.isArray(health)) throw new Invalid("health")
  return {
    report: {
      kind,
      date: document.date,
      summary: text(document.summary, "summary", "summary"),
      sections,
      health: health.map((entry, h): HealthEntry => {
        const at = `health[${h}]`
        if (!isObject(entry) || typeof entry.stale_hours !== "number" || !(entry.stale_hours >= 0))
          throw new Invalid(at)
        const source = text(entry.source, "source", `${at}.source`)
        if (source === null) throw new Invalid(`${at}.source`)
        return { source, staleHours: entry.stale_hours, refs: refsOf(entry.refs, `${at}.refs`) }
      }),
    },
    leaks,
  }
}

export type ParsedReport = { report: Report; leaks: number } | { invalid: string }

/**
 * A run's answer as a report: one JSON object, bare or as the only fenced `json` block. Text that is neither is not a
 * report (`undefined`) and keeps the Markdown path; a JSON answer that fails the check is `invalid`, with the path
 * of the first field that failed, and is never shown.
 */
export const parseReport = (answer: string): ParsedReport | undefined => {
  const text = answer.trim()
  const fenced = /^```json[ \t]*\n([\s\S]*?)\n```$/.exec(text)?.[1]
  const json = fenced ?? (text.startsWith("{") ? text : undefined)
  if (json === undefined) return undefined
  let document: unknown
  try {
    document = JSON.parse(json)
  } catch {
    return { invalid: "json" }
  }
  try {
    return checked(document)
  } catch (error) {
    if (error instanceof Invalid) return { invalid: error.message }
    throw error
  }
}
