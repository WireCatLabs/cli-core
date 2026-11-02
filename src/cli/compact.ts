import { visibleControls } from "@wirecat/cli-base"
import { metaOf } from "@wirecat/cli-base/commands"
import type { NextStep } from "@wirecat/cli-base/standards"
import type { Command } from "commander"
import { ENTITIES } from "../entities/index.js"
import { answerRow } from "./answer-entity.js"
import type { Body } from "./envelope.js"

/** How one column prints. `text` by default. */
export type RowValue = "text" | "time" | "day" | "count" | "files" | "reply" | "forward"

export interface RowColumn {
  /** A snake_case field path in the item (`sender_name`, `last.timestamp`); of several, the first that is set. */
  field: string | readonly string[]
  as?: RowValue
  /** Printed for a field that is `true`, and after a count: `{ field: ["sender_is_me", "sender_name"], tag: "me" }`. */
  tag?: string
}

export interface RowShape {
  /** Printed in order, joined by " · "; the first is the ref. A missing value is left out. */
  columns: readonly RowColumn[]
  /** The free text, printed last; the first non-empty field wins. */
  text?: readonly string[]
  /** An item answer's lists, drawn as rows of another entity: `{ items: "evidence_item" }`. */
  sections?: Readonly<Record<string, string>>
}

export interface CompactOptions {
  /** IANA zone for times; the answer's `meta.timezone` wins. */
  timezone: string
  /** Characters of text kept per row; 0 keeps all (`--full`). Default 400. */
  textChars?: number
}

export const TEXT_CHARS = 400

const sender: RowColumn = { field: ["sender_is_me", "sender_name"], tag: "me" }
const messageRow: RowShape = {
  columns: [
    { field: "ref" },
    { field: "timestamp", as: "time" },
    { field: "chat_title" },
    sender,
    { field: ["reply_to_id", "reply_to.id"], as: "reply" },
    { field: "forwarded_from", as: "forward" },
    { field: "attachments", as: "files" },
  ],
  text: ["text", "transcript", "excerpt"],
}

/** Rows for cli-core's shared entities. */
export const SHARED_ROWS: Readonly<Record<string, RowShape>> = {
  message: messageRow,
  "message.summary": messageRow,
  "message.hit": {
    columns: [
      { field: "ref" },
      { field: "timestamp", as: "time" },
      { field: "chat_title" },
      sender,
      { field: "attachments", as: "files" },
    ],
    text: ["excerpt", "text"],
  },
  chat: {
    columns: [
      { field: "ref" },
      { field: "title" },
      { field: "kind" },
      { field: "unread_count", as: "count", tag: "unread" },
      { field: "last_message_at", as: "time" },
    ],
  },
}

/** Any record: what names it, what it is called, what state it is in, then what it says. */
export const GENERIC_ROW: RowShape = {
  columns: [{ field: ["key", "ref", "id"] }, { field: ["title", "name", "path"] }, { field: ["state", "status"] }],
  text: ["text", "excerpt"],
}

export type RowsResolver = (command: Command | undefined) => RowShape | undefined

const declaredNames = (command: Command | undefined): string[] => {
  const output = command ? metaOf(command).output : undefined
  if (!output) return []
  return output.view ? [`${output.entity}.${output.view}`, output.entity] : [output.entity]
}

/** An app's own rows by entity name, as `entityFields` takes its fields; a shared name is refused. */
export const entityRows = (table: Readonly<Record<string, RowShape>>): RowsResolver => {
  const shared = Object.keys(table).filter((name) => name in ENTITIES || name in SHARED_ROWS)
  if (shared.length > 0) throw new Error(`entityRows: ${shared.join(", ")} is cli-core's entity; name yours apart`)
  return (command) => {
    const name = declaredNames(command).find((one) => Object.hasOwn(table, one))
    return name === undefined ? undefined : table[name]
  }
}

/** The row a command's answer is drawn with: its own, its app's, the shared one, else the generic one. */
export const rowShapeOf = (command: Command | undefined, resolve?: RowsResolver): RowShape => {
  const own = answerRow(command) ?? resolve?.(command)
  if (own) return own
  const shared = declaredNames(command).find((name) => Object.hasOwn(SHARED_ROWS, name))
  return shared === undefined ? GENERIC_ROW : (SHARED_ROWS[shared] as RowShape)
}

type Fields = Record<string, unknown>
const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const present = (value: unknown) =>
  value !== null && value !== undefined && value !== "" && value !== false && !(Array.isArray(value) && !value.length)

const at = (item: Fields, path: string): unknown =>
  path.split(".").reduce<unknown>((value, key) => (isFields(value) ? value[key] : undefined), item)

const fieldsOfColumn = (field: RowColumn["field"]): readonly string[] => (typeof field === "string" ? [field] : field)

const firstSet = (item: Fields, field: RowColumn["field"]): unknown =>
  fieldsOfColumn(field)
    .map((path) => at(item, path))
    .find(present)

const sourceOf = (item: Fields, field: RowColumn["field"]): string | undefined =>
  fieldsOfColumn(field).find((path) => present(at(item, path)))

// Whitespace runs become one space and control or direction characters show, so a text cannot start a row of its own.
const clean = (text: string): string => visibleControls(text.replace(/\s+/g, " ").trim())

const cut = (text: string, chars: number): string => {
  if (chars <= 0) return text
  const letters = Array.from(text)
  return letters.length <= chars ? text : `${letters.slice(0, chars).join("")}…(+${letters.length - chars})`
}

interface Clock {
  zone: string
  parts: (iso: string) => { date: string; time: string } | undefined
}

const clockFor = (zone: string): Clock => {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
  return {
    zone,
    parts: (iso) => {
      const ms = Date.parse(iso)
      if (Number.isNaN(ms)) return undefined
      const part = Object.fromEntries(format.formatToParts(ms).map(({ type, value }) => [type, value]))
      return { date: `${part.year}-${part.month}-${part.day}`, time: `${part.hour}:${part.minute}` }
    },
  }
}

const duration = (seconds: number) => {
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`
}

const fileTag = (file: unknown): string | undefined => {
  if (!isFields(file)) return undefined
  const kind = typeof file.kind === "string" && file.kind !== "" ? file.kind : "file"
  const extra =
    typeof file.duration === "number" ? duration(file.duration) : typeof file.name === "string" ? file.name : ""
  return `[${clean(extra ? `${kind} ${extra}` : kind)}]`
}

interface Cell {
  text: string
  /** The date, in the answer's zone, for the header's span. */
  date?: string
}

const cellOf = (item: Fields, column: RowColumn, clock: Clock): Cell | undefined => {
  const value = firstSet(item, column.field)
  if (!present(value)) return undefined
  switch (column.as) {
    case "time":
    case "day": {
      if (typeof value !== "string") return undefined
      const parts = clock.parts(value)
      if (!parts) return { text: clean(value) }
      const day = parts.date.slice(5)
      return { text: column.as === "day" ? day : `${day} ${parts.time}`, date: parts.date }
    }
    case "count":
      return typeof value === "number" && value !== 0
        ? { text: column.tag ? `${value} ${column.tag}` : String(value) }
        : undefined
    case "files": {
      const tags = (Array.isArray(value) ? value : [value]).map(fileTag).filter((tag) => tag !== undefined)
      return tags.length ? { text: tags.join(" ") } : undefined
    }
    case "reply": {
      const id = isFields(value) ? value.id : value
      return typeof id === "string" || typeof id === "number" ? { text: `↳#${clean(String(id))}` } : undefined
    }
    case "forward": {
      const name = isFields(value) ? value.sender_name : value
      return { text: typeof name === "string" && name !== "" ? `↪ ${clean(name)}` : "↪" }
    }
    default:
      if (value === true) return column.tag ? { text: column.tag } : undefined
      if (typeof value === "string" || typeof value === "number") return { text: clean(String(value)) }
      return undefined
  }
}

const textOf = (item: Fields, shape: RowShape, chars: number): string | undefined => {
  const value = (shape.text ?? [])
    .map((field) => at(item, field))
    .find((one) => typeof one === "string" && present(one))
  return typeof value === "string" ? cut(clean(value), chars) : undefined
}

// A line that starts with "# " is the answer's own; a row is shifted so that no item can pass for one.
const guarded = (line: string) => (line.startsWith("#") && !/^#[^\s#]/.test(line) ? `\\${line}` : line)

const REF = /^[a-z]+:\S*\/[^/\s]+$/

/** The shared part of the refs up to their last `/`, when every row has one and there is more than one row. */
const sharedPrefix = (refs: readonly (string | undefined)[]): string | undefined => {
  if (refs.length < 2 || !refs.every((ref) => ref !== undefined && REF.test(ref))) return undefined
  const prefixes = new Set(refs.map((ref) => (ref as string).slice(0, (ref as string).lastIndexOf("/") + 1)))
  return prefixes.size === 1 ? [...prefixes][0] : undefined
}

const span = (dates: readonly string[]) => {
  if (!dates.length) return undefined
  const sorted = [...dates].sort()
  const first = sorted[0] as string
  const last = sorted[sorted.length - 1] as string
  return first === last ? first : `${first}…${last}`
}

interface Drawn {
  header: string[]
  lines: string[]
}

// A column every row prints the same, a chat's title in a list of its messages, is said once in the header.
const sameEverywhere = (rows: readonly { cells: readonly (Cell | undefined)[] }[], index: number): boolean => {
  const first = rows[0]?.cells[index]?.text
  return first !== undefined && rows.every(({ cells }) => cells[index]?.text === first)
}

const rowsOfItems = (items: readonly unknown[], shape: RowShape, clock: Clock, chars: number): Drawn => {
  const dates: string[] = []
  const rows = items.map((item) => {
    if (!isFields(item)) return { cells: [], text: clean(String(item)) }
    const cells = shape.columns.map((column) => cellOf(item, column, clock))
    for (const cell of cells) if (cell?.date) dates.push(cell.date)
    return { cells, text: textOf(item, shape, chars), item }
  })
  const firstColumn = shape.columns[0]
  const refs = rows.map(({ item }) =>
    item && firstColumn ? (firstSet(item, firstColumn.field) as string | undefined) : undefined,
  )
  const prefix = sharedPrefix(refs.map((ref) => (typeof ref === "string" ? ref : undefined)))
  const hoisted = rows.length < 2 ? [] : shape.columns.map((_, index) => index > 0 && sameEverywhere(rows, index))
  const named = hoisted.flatMap((hoist, index) => {
    const column = shape.columns[index]
    const item = rows[0]?.item
    if (!hoist || !column || !item) return []
    return [`${sourceOf(item, column.field) ?? fieldsOfColumn(column.field)[0]}: ${rows[0]?.cells[index]?.text}`]
  })
  const lines = rows.map(({ cells, text, item }) => {
    const parts = cells.map((cell, index) => (hoisted[index] ? undefined : cell?.text))
    const shortened = prefix ? clean(prefix) : undefined
    if (shortened && parts[0]?.startsWith(shortened)) parts[0] = `#${parts[0].slice(shortened.length)}`
    const shown = [...parts, text].filter((part): part is string => part !== undefined && part !== "")
    return guarded(shown.length ? shown.join(" · ") : item ? blockLine(item, chars) : "")
  })
  const when = span(dates)
  const header = [...(prefix ? [`ref: ${clean(prefix)}<id>`] : []), ...named, ...(when ? [when, clock.zone] : [])]
  return { header, lines }
}

const blockLine = (fields: Fields, chars: number) => blockOf(fields, chars).join("  ")

/** A record as `field: value` lines; a nested record is indented under its field, a list of records counted. */
const blockOf = (fields: Fields, chars: number, indent = ""): string[] =>
  Object.entries(fields)
    .filter(([name]) => !(name === "priority" && "priority_label" in fields))
    .filter(([, value]) => present(value) || value === false)
    .flatMap(([name, value]) => {
      const label = `${indent}${clean(name)}:`
      if (isFields(value)) return [label, ...blockOf(value, chars, `${indent}  `)]
      if (Array.isArray(value))
        return value.every((one) => !isFields(one) && !Array.isArray(one))
          ? [`${label} ${cut(clean(value.join(", ")), chars)}`]
          : [`${label} ${value.length} — --json shows them`]
      return [`${label} ${cut(clean(String(value)), chars)}`]
    })

const footerOf = (body: Body): string[] => {
  const lines: string[] = []
  const steps: readonly NextStep[] = body.next ?? []
  const lineOf = (step: NextStep) => (step.kind === "command" ? (step.line ?? step.command) : undefined)
  if ("items" in body && body.page.has_more) {
    const more = steps.find((step) => step.step === "page.next")
    const line = more?.kind === "command" ? more.line : undefined
    const page = body.page
    lines.push(
      `# more: ${
        line ??
        (page.mode === "cursor" && page.next_cursor
          ? `--cursor ${page.next_cursor}`
          : page.mode === "page" && page.next_page
            ? `--page ${page.next_page}`
            : "raise --limit")
      }`,
    )
  }
  for (const missing of body.missing ?? []) lines.push(`# missing: ${clean(missing.field)}: ${clean(missing.why)}`)
  for (const step of steps) {
    if (step.step === "page.next" && "items" in body) continue
    const line = lineOf(step)
    lines.push(`# next: ${clean(step.why)}${line ? `: ${line}` : ""}`)
  }
  if (body.meta?.complete === false) {
    const issues = (body.meta.issues ?? []).map((issue) => `${clean(issue.source)}: ${issue.code}`)
    lines.push(`# complete: false${issues.length ? ` (${issues.join(", ")})` : ""}`)
  }
  if (body.meta?.truncated) lines.push("# truncated: true")
  return lines
}

const usableZone = (zone: string | undefined): string | undefined => {
  if (!zone) return undefined
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone })
    return zone
  } catch {
    return undefined
  }
}

/** The whole answer as compact text: header, rows, footer. Pure: no store, no clock. */
export const compactText = <T>(
  body: Body<T>,
  shape: RowShape,
  options: CompactOptions,
  rowsOf: (entity: string) => RowShape = (entity) => SHARED_ROWS[entity] ?? GENERIC_ROW,
): string => {
  const clock = clockFor(usableZone(body.meta?.timezone) ?? usableZone(options.timezone) ?? "UTC")
  const chars = options.textChars ?? TEXT_CHARS
  let lines: string[] = []
  if ("items" in body) {
    const { header, lines: rows } = rowsOfItems(body.items, shape, clock, chars)
    lines = (header.length ? [`# ${header.join(" · ")}`] : []).concat(rows.length ? rows : ["# nothing found"])
  } else if (isFields(body.item)) {
    const sections = shape.sections ?? {}
    const rest = Object.fromEntries(Object.entries(body.item).filter(([name]) => !Object.hasOwn(sections, name)))
    lines = blockOf(rest, chars).map(guarded)
    for (const [name, entity] of Object.entries(sections)) {
      const list = body.item[name]
      if (!Array.isArray(list)) continue
      const { header, lines: rows } = rowsOfItems(list, rowsOf(entity), clock, chars)
      lines = lines.concat([`# ${[`${clean(name)}: ${list.length}`, ...header].join(" · ")}`], rows)
    }
  } else if (present(body.item)) lines = [guarded(cut(clean(String(body.item)), chars))]
  return lines.concat(footerOf(body as Body)).join("\n")
}
