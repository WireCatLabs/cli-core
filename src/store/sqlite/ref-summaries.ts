import { dealLine } from "../../domain/deals.js"
import { invoiceLine, paymentLine } from "../../domain/finance.js"
import { orderLine } from "../../domain/orders.js"
import { filesAccountSql, providerLabel, providerNamed } from "../../domain/providers.js"
import { oneLine, type RefState, type RefSummary, type RefSummaryKind } from "../../domain/ref-summaries.js"
import { formatReference, parseReference, type Reference } from "../../domain/references.js"
import type { CacheDatabase, SqlValue } from "../driver.js"

/** A summary plus what an evidence reader shows beside it; `summaries` drops the extra fields. */
export interface RefRead extends RefSummary {
  sender: string | null
  excerpt: string | null
}

interface Found {
  title: string | null
  holder: string | null
  sender: string | null
  at: number | null
  provider: string | null
  account: string | null
  deleted: boolean
  body: string | null
}

interface Reader {
  kind: RefSummaryKind
  /** Selects `n` and the `Found` columns from `w(n, k1…)`, the wanted refs; one row per ref the store holds. */
  sql(body: boolean): string
}

interface Wanted {
  text: string
  reference: Reference
  keys: SqlValue[]
}

const EXCERPT_CHARS = 280
const TITLE_CHARS = 120
const MEMORY_TITLE_CHARS = 80
/** SQLite's parameter limit is per statement; a long page is read in slices, still one statement per slice. */
const SLICE = 500

const flat = (value: unknown): string | null => {
  if (value == null) return null
  const text = oneLine(String(value))
  return text === "" ? null : text
}

const cut = (text: string | null, chars: number) =>
  text === null || text.length <= chars ? text : `${text.slice(0, chars - 1)}…`

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString())
const minute = (at: number | null) => iso(at)?.slice(0, 16).replace("T", " ") ?? null
const storeId = (text: string) => (/^[1-9]\d{0,15}$/.test(text) ? Number(text) : undefined)

const bodyOr = (body: boolean, column: string) => (body ? column : "NULL")

const PERSON_NAME =
  "coalesce(p.name, (SELECT a.name FROM aliases a WHERE a.aliasable_type = 'person' AND a.aliasable_id = p.id " +
  "ORDER BY a.display DESC, a.id LIMIT 1), (SELECT i.name FROM identity_links l JOIN identities i " +
  "ON i.id = l.identity_id WHERE l.person_id = p.id AND i.name IS NOT NULL ORDER BY i.id LIMIT 1))"

/** What a row is about, by name; the owner is left out, or every owner's note would say whose it is. */
const subjectName = (type: string, id: string) =>
  `CASE ${type} WHEN 'person' THEN (SELECT ${PERSON_NAME} FROM persons p WHERE p.id = ${id} AND p.owner = 0) ` +
  `WHEN 'project' THEN (SELECT name FROM projects WHERE id = ${id}) ` +
  `WHEN 'organization' THEN (SELECT name FROM organizations WHERE id = ${id}) ` +
  `WHEN 'account' THEN (SELECT name FROM accounts WHERE id = ${id}) END`

const select = (columns: Partial<Record<keyof Found, string>>) =>
  `SELECT w.n, ${(["title", "holder", "sender", "at", "provider", "account", "deleted", "body"] as const)
    .map((column) => `${columns[column] ?? "NULL"} AS ${column}`)
    .join(", ")}`

const byId = (
  kind: RefSummaryKind,
  table: string,
  columns: (body: boolean) => Partial<Record<keyof Found, string>>,
) => ({
  kind,
  sql: (body: boolean) => `${select(columns(body))} FROM w JOIN ${table} x ON x.id = w.k1`,
})

const crmColumns = () => ({
  title:
    "json_object('id', x.id, 'title', x.title, 'stage', (SELECT name FROM pipeline_stages WHERE id = x.stage_id), " +
    "'amount', x.amount, 'currency', x.currency, 'status', x.status)",
  holder: "(SELECT name FROM projects WHERE id = x.project_id)",
  at: "x.created_at",
  deleted: "x.deleted_at",
})

const READERS = {
  message: {
    kind: "message",
    sql: (body) =>
      `${select({
        holder: "c.title",
        sender: "coalesce(m.sender_name, i.name)",
        at: "m.sent_at",
        provider: "a.provider",
        account: "a.external_id",
        deleted: "m.deleted_at",
        body: bodyOr(body, "m.text"),
      })} FROM w JOIN accounts a ON a.provider = w.k1 AND a.external_id = w.k2 ` +
      "JOIN chats c ON c.account_id = a.id AND c.external_id = w.k3 " +
      "JOIN messages m ON m.chat_id = c.id AND m.external_id = w.k4 LEFT JOIN identities i ON i.id = m.sender_identity_id",
  },
  email: {
    kind: "email",
    sql: (body) =>
      `${select({
        title: "e.subject",
        holder: "coalesce(e.from_name, e.from_address)",
        sender: "coalesce(e.from_name, e.from_address)",
        at: "e.sent_at",
        provider: "'email'",
        account: "a.external_id",
        deleted: "e.deleted_at",
        body: bodyOr(body, "coalesce(e.body_text, e.snippet)"),
      })} FROM w JOIN accounts a ON a.provider = 'email' AND a.external_id = w.k1 ` +
      "JOIN email_threads t ON t.account_id = a.id AND t.external_id = w.k2 " +
      "JOIN emails e ON e.email_thread_id = t.id AND e.external_id = w.k3",
  },
  chat: {
    kind: "chat",
    sql: () =>
      `${select({
        title: "c.title",
        at: "(SELECT max(sent_at) FROM messages WHERE chat_id = c.id)",
        provider: "a.provider",
        account: "a.external_id",
      })} FROM w JOIN accounts a ON a.provider = w.k1 AND a.external_id = w.k2 ` +
      "JOIN chats c ON c.account_id = a.id AND c.external_id = w.k3",
  },
  email_thread: {
    kind: "email_thread",
    sql: () =>
      `${select({
        title: "t.subject",
        holder: "a.external_id",
        at: "t.last_email_at",
        provider: "'email'",
        account: "a.external_id",
        deleted: "t.deleted_at",
      })} FROM w JOIN accounts a ON a.provider = 'email' AND a.external_id = w.k1 ` +
      "JOIN email_threads t ON t.account_id = a.id AND t.external_id = w.k2",
  },
  contact: {
    kind: "contact",
    sql: () =>
      `${select({ title: "coalesce(i.name, '@' || i.username)", provider: "i.provider" })} ` +
      "FROM w JOIN identities i ON i.provider = w.k1 AND i.external_id = w.k2",
  },
  folder: {
    kind: "folder",
    sql: () =>
      `${select({ title: "a.name", provider: "a.provider", account: "a.external_id" })} ` +
      `FROM w JOIN accounts a ON a.id = w.k1 AND ${filesAccountSql("a.provider")}`,
  },
  task: {
    kind: "task",
    // A task moved to another project took a new key there; its old key still names it, as in `taskRowOf`.
    sql: (body) =>
      `${select({
        title: "CASE WHEN x.key IS NULL THEN x.title ELSE x.key || ' · ' || x.title END",
        holder: "p.name",
        at: "x.due_at",
        deleted: "x.deleted_at",
        body: bodyOr(body, "x.description"),
      })} FROM w JOIN tasks x ON x.id = coalesce(` +
      "(SELECT id FROM tasks WHERE package_id = w.k1 OR key = w.k1 ORDER BY id LIMIT 1), " +
      "(SELECT task_id FROM task_events WHERE kind = 'project' AND json_extract(changes, '$.key[0]') = w.k1 " +
      "ORDER BY id DESC LIMIT 1)) LEFT JOIN projects p ON p.id = x.project_id",
  },
  meeting: {
    kind: "meeting",
    sql: (body) =>
      `${select({
        title: "m.title",
        holder: "coalesce(a.name, a.external_id)",
        sender: "r.speaker_name",
        at: "m.started_at + coalesce(r.start_ms, 0)",
        provider: "a.provider",
        account: "a.external_id",
        deleted: "coalesce(m.deleted_at, t.deleted_at)",
        body: bodyOr(body, "CASE WHEN w.k4 IS NOT NULL THEN r.text WHEN w.k3 IS NULL THEN m.description END"),
      })} FROM w JOIN meetings m ON m.id = w.k2 AND m.account_id = w.k1 LEFT JOIN accounts a ON a.id = m.account_id ` +
      "LEFT JOIN meeting_transcripts t ON t.id = w.k3 AND t.meeting_id = m.id " +
      "LEFT JOIN meeting_transcript_rows r ON r.meeting_transcript_id = t.id AND r.position = w.k4 " +
      "WHERE (w.k3 IS NULL OR t.id IS NOT NULL) AND (w.k4 IS NULL OR r.id IS NOT NULL)",
  },
  event: {
    kind: "event",
    sql: (body) =>
      `${select({
        title: "x.title",
        holder: "c.title",
        at: "x.starts_at",
        provider: "a.provider",
        account: "a.external_id",
        deleted: "x.deleted_at",
        body: bodyOr(body, "x.description"),
      })} FROM w JOIN events x ON x.id = w.k1 ` +
      "LEFT JOIN calendar_entries ce ON ce.id = (SELECT min(id) FROM calendar_entries WHERE event_id = x.id) " +
      "LEFT JOIN calendars c ON c.id = ce.calendar_id LEFT JOIN accounts a ON a.id = c.account_id",
  },
  document: {
    kind: "document",
    sql: (body) =>
      `${select({
        title: "coalesce(x.title, x.file_name)",
        at: "coalesce(x.external_updated_at, x.updated_at)",
        provider: "a.provider",
        account: "a.external_id",
        deleted: "x.deleted_at",
        body: bodyOr(body, "x.body"),
      })} FROM w JOIN documents x ON x.id = w.k1 LEFT JOIN accounts a ON a.id = x.account_id`,
  },
  note: byId("note", "notes", (body) => ({
    title: "x.title",
    holder: subjectName("x.notable_type", "x.notable_id"),
    at: "x.updated_at",
    provider: "'notes'",
    deleted: "x.deleted_at",
    body: bodyOr(body, "x.body"),
  })),
  person: {
    kind: "person",
    sql: () => `${select({ title: PERSON_NAME })} FROM w JOIN persons p ON p.id = w.k1`,
  },
  organization: byId("organization", "organizations", () => ({ title: "x.name", deleted: "x.deleted_at" })),
  project: byId("project", "projects", () => ({
    title: "CASE WHEN x.key IS NULL THEN x.name ELSE x.key || ' · ' || x.name END",
    deleted: "x.deleted_at",
  })),
  memory: byId("memory", "memories", (body) => ({
    title: "substr(x.body, 1, 400)",
    holder: subjectName("x.subject_type", "x.subject_id"),
    at: "x.created_at",
    deleted: "x.deleted_at",
    body: bodyOr(body, "x.body"),
  })),
  fact: byId("fact", "facts", (body) => ({
    title: "substr(x.statement, 1, 400)",
    holder: subjectName("x.subject_type", "x.subject_id"),
    at: "x.created_at",
    deleted: "x.deleted_at",
    body: bodyOr(body, "x.statement"),
  })),
  bot: byId("bot", "bots", () => ({ title: "x.name" })),
  // Money is formatted with its currency's scale in JS, so SQL hands `titleOf` the fields as JSON.
  invoice: byId("invoice", "invoices", () => ({
    title:
      "json_object('id', x.id, 'number', x.number, 'direction', x.direction, 'total', x.total, " +
      `'currency', x.currency, 'counterpartyName', ${subjectName("x.counterparty_type", "x.counterparty_id")}, ` +
      "'dueDate', x.due_date, 'status', x.status, 'review', x.review)",
    holder: "(SELECT name FROM projects WHERE id = x.project_id)",
    at: "x.created_at",
    deleted: "x.deleted_at",
  })),
  payment: byId("payment", "payments", () => ({
    title:
      "json_object('direction', x.direction, 'amount', x.amount, 'currency', x.currency, 'partyName', " +
      `CASE x.direction WHEN 'in' THEN ${subjectName("x.payer_type", "x.payer_id")} ` +
      `ELSE ${subjectName("x.payee_type", "x.payee_id")} END, 'date', x.payment_date, 'review', x.review)`,
    holder: "(SELECT name FROM projects WHERE id = x.project_id)",
    at: "x.created_at",
    deleted: "x.deleted_at",
  })),
  order: byId("order", "orders", () => ({
    title:
      "json_object('id', x.id, 'number', x.number, 'supplierName', x.supplier_name, 'total', x.total, " +
      "'currency', x.currency, 'status', x.status, 'review', x.review)",
    holder: "(SELECT name FROM projects WHERE id = x.project_id)",
    at: "x.created_at",
    deleted: "x.deleted_at",
  })),
  deal: byId("deal", "deals", crmColumns),
  lead: byId("lead", "leads", crmColumns),
  pipeline: byId("pipeline", "pipelines", () => ({ title: "x.name", at: "x.created_at" })),
} satisfies Record<string, Reader>

type ReaderName = keyof typeof READERS

/** Mail saved before the mail tables existed is still messages, so a miss there is read again as a message. */
const FALLBACK: Partial<Record<ReaderName, ReaderName>> = { email: "message", email_thread: "chat" }

const route = (reference: Reference): { reader: ReaderName; keys: SqlValue[] } | undefined => {
  switch (reference.type) {
    case "message":
      return reference.provider === "email"
        ? { reader: "email", keys: [reference.account, reference.chat, reference.message] }
        : { reader: "message", keys: [reference.provider, reference.account, reference.chat, reference.message] }
    case "chat":
      return reference.provider === "email"
        ? { reader: "email_thread", keys: [reference.account, reference.chat] }
        : { reader: "chat", keys: [reference.provider, reference.account, reference.chat] }
    case "contact":
      return { reader: "contact", keys: [reference.provider, reference.id] }
    case "meeting":
      return {
        reader: "meeting",
        keys: [reference.accountId, reference.meetingId, reference.transcriptId ?? null, reference.cuePosition ?? null],
      }
    case "task":
      return { reader: "task", keys: [reference.id] }
    case "entity":
      return undefined
    case "folder": {
      const id = storeId(reference.id)
      return id === undefined ? undefined : { reader: "folder", keys: [id] }
    }
    default: {
      const id = storeId(reference.id)
      return id === undefined ? undefined : { reader: reference.type, keys: [id] }
    }
  }
}

const keysOf = (reader: ReaderName, reference: Reference): SqlValue[] => {
  if (reader === "message" && reference.type === "message")
    return [reference.provider, reference.account, reference.chat, reference.message]
  if (reader === "chat" && reference.type === "chat") return [reference.provider, reference.account, reference.chat]
  return []
}

const kindOfReference = (reference: Reference): RefSummaryKind =>
  reference.type === "entity"
    ? "unknown"
    : reference.type === "message" && reference.provider === "email"
      ? "email"
      : reference.type === "chat" && reference.provider === "email"
        ? "email_thread"
        : reference.type

const runReader = (
  database: CacheDatabase,
  reader: Reader,
  wanted: readonly Wanted[],
  body: boolean,
): Map<number, Found> => {
  const found = new Map<number, Found>()
  const width = wanted[0]?.keys.length ?? 0
  const names = Array.from({ length: width }, (_, at) => `k${at + 1}`)
  for (let start = 0; start < wanted.length; start += SLICE) {
    const slice = wanted.slice(start, start + SLICE)
    const values = slice.map(() => `(${["?", ...names.map(() => "?")].join(", ")})`).join(", ")
    const sql = `WITH w(n, ${names.join(", ")}) AS (VALUES ${values}) ${reader.sql(body)}`
    const parameters = slice.flatMap((one, at) => [start + at, ...one.keys])
    for (const row of database.prepare(sql).all(...parameters)) {
      const n = Number(row.n)
      if (found.has(n)) continue
      found.set(n, {
        title: flat(row.title),
        holder: flat(row.holder),
        sender: flat(row.sender),
        at: row.at == null ? null : Number(row.at),
        provider: row.provider == null ? null : String(row.provider),
        account: row.account == null ? null : String(row.account),
        deleted: row.deleted != null,
        body: row.body == null ? null : String(row.body),
      })
    }
  }
  return found
}

const toolOf = (provider: string | null) => (provider === null ? null : (providerNamed(provider)?.command ?? null))

const refOfAccount = (reference: Reference): { provider: string | null; account: string | null } =>
  reference.type === "message" || reference.type === "chat"
    ? { provider: reference.provider, account: reference.account }
    : reference.type === "contact"
      ? { provider: reference.provider, account: null }
      : { provider: null, account: null }

/** A summary never throws: fields that no longer parse, after `flat` made them one line, read as no title. */
const fieldsOf = <T>(json: string | null, line: (fields: T) => string): string | null => {
  if (json === null) return null
  try {
    return line(JSON.parse(json) as T)
  } catch {
    return null
  }
}

const titleOf = (kind: RefSummaryKind, reference: Reference, found: Found): string | null => {
  switch (kind) {
    case "message": {
      const words = [found.sender, minute(found.at)].filter((one) => one !== null)
      return words.length === 0 ? null : words.join(" · ")
    }
    case "memory":
    case "fact":
      return cut(found.title, MEMORY_TITLE_CHARS)
    case "invoice":
      return fieldsOf(found.title, invoiceLine)
    case "payment":
      return fieldsOf(found.title, paymentLine)
    case "order":
      return fieldsOf(found.title, orderLine)
    case "deal":
    case "lead":
      return fieldsOf(found.title, dealLine)
    case "folder":
      return reference.type === "folder" && reference.path !== null && found.title !== null
        ? `${found.title}/${reference.path}`
        : found.title
    default:
      return found.title
  }
}

const inOf = (kind: RefSummaryKind, found: Found): string | null =>
  found.holder ??
  ((kind === "chat" || kind === "contact" || kind === "document") && found.provider !== null
    ? providerLabel(found.provider)
    : null)

const readOf = (wanted: Wanted, found: Found | undefined, reader: Reader | undefined, excerpt: boolean): RefRead => {
  const ref = formatReference(wanted.reference)
  if (found === undefined || reader === undefined) {
    const { provider, account } = refOfAccount(wanted.reference)
    return {
      ref,
      kind: kindOfReference(wanted.reference),
      title: null,
      in: null,
      at: null,
      provider,
      account,
      tool: toolOf(provider),
      state: "unavailable",
      sender: null,
      excerpt: null,
    }
  }
  const state: RefState = found.deleted ? "deleted" : "available"
  return {
    ref,
    kind: reader.kind,
    title: cut(titleOf(reader.kind, wanted.reference, found), TITLE_CHARS),
    in: cut(inOf(reader.kind, found), TITLE_CHARS),
    at: iso(found.at),
    provider: found.provider,
    account: found.account,
    tool: toolOf(found.provider),
    state,
    sender: found.sender,
    excerpt: excerpt && state === "available" ? cut(flat(found.body), EXCERPT_CHARS) : null,
  }
}

const unknown = (text: string): RefRead => ({
  ref: text.trim(),
  kind: "unknown",
  title: null,
  in: null,
  at: null,
  provider: null,
  account: null,
  tool: null,
  state: "unavailable",
  sender: null,
  excerpt: null,
})

const parsed = (text: string): Reference | undefined => {
  try {
    return parseReference(text)
  } catch {
    return undefined
  }
}

/**
 * Every ref read back in one statement per kind present, keyed by the text passed and in its order. A bad ref is
 * `unknown` and a ref the store lacks is `unavailable`: one bad row must not fail a page of them.
 */
export const refReadsOf = (
  database: CacheDatabase,
  texts: readonly string[],
  { excerpt = false }: { excerpt?: boolean } = {},
): Map<string, RefRead> => {
  const reads = new Map<string, RefRead>()
  const groups = new Map<ReaderName, Wanted[]>()
  for (const text of new Set(texts)) {
    const reference = parsed(text)
    const routed = reference === undefined ? undefined : route(reference)
    if (reference === undefined || routed === undefined) {
      reads.set(
        text,
        reference === undefined ? unknown(text) : readOf({ text, reference, keys: [] }, undefined, undefined, false),
      )
      continue
    }
    reads.set(text, unknown(text))
    const group = groups.get(routed.reader) ?? []
    group.push({ text, reference, keys: routed.keys })
    groups.set(routed.reader, group)
  }
  const pending = [...groups.entries()]
  while (pending.length > 0) {
    const [name, wanted] = pending.shift() as [ReaderName, Wanted[]]
    const reader = READERS[name]
    const found = runReader(database, reader, wanted, excerpt)
    const fallback = FALLBACK[name]
    const missed: Wanted[] = []
    for (const [n, one] of wanted.entries()) {
      const row = found.get(n)
      if (row === undefined && fallback !== undefined) missed.push(one)
      reads.set(one.text, readOf(one, row, reader, excerpt))
    }
    if (fallback !== undefined && missed.length > 0)
      pending.push([fallback, missed.map((one) => ({ ...one, keys: keysOf(fallback, one.reference) }))])
  }
  return reads
}

const summaryOf = ({ sender, excerpt, ...summary }: RefRead, withExcerpt: boolean): RefSummary =>
  withExcerpt ? { ...summary, excerpt } : summary

export const refSummariesOf = (
  database: CacheDatabase,
  texts: readonly string[],
  options: { excerpt?: boolean } = {},
): Map<string, RefSummary> =>
  new Map(
    [...refReadsOf(database, texts, options)].map(([text, read]) => [text, summaryOf(read, options.excerpt === true)]),
  )
