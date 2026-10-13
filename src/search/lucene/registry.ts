import {
  type FieldSpec,
  type Occur,
  type Operator,
  type Predicate,
  type QueryAst,
  type QueryNode,
  type QueryRegistry,
  type Span,
  validateQuery,
  walkQuery,
} from "@wirecat/cli-base/query"
import { tagOf } from "../../domain/tags.js"
import { QUERY_LIMITS, SEARCH_QUERY, searchError } from "./types.js"

export const FIELD_VERSION = 2

/** A message search field: the shared field shape and what the search guide says about its index. */
export interface MessageField extends FieldSpec {
  index: string
  aliases: readonly string[]
  normalization: string
  support: "A1" | "A2"
}

const UNITS: Record<string, number> = {
  "": 1,
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
}
export const parseBytes = (value: string, span: Span): number => {
  const [, amount, unit] = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/iu.exec(value.trim()) ?? []
  const scale = UNITS[unit?.toLowerCase() ?? ""]
  if (amount === undefined || scale === undefined)
    searchError("query.invalid-size", span, "use bytes or KB/MB/GB, e.g. 10MB")
  return Math.round(Number(amount) * scale)
}

// Only text, exact and body may be empty: their compilers give an empty value a meaning.
const filled = (node: Predicate): void => {
  if (node.value === "") searchError("query.missing-value", node.span)
}
const validateSize = (node: Predicate): void => {
  for (const bound of node.operator === "range" ? [node.value, node.upper] : [node.value])
    if (bound !== undefined && bound !== "*") parseBytes(bound, node.span)
}
const validateTag = (node: Predicate): void => {
  if (tagOf(node.value) === undefined)
    searchError("query.invalid-tag", node.span, "a tag is 1-32 letters a-z, digits and hyphens")
}
const validateTopic = (node: Predicate): void => {
  if (!/^\d+$/u.test(node.value)) searchError("query.invalid-topic", node.span, "use a thread id in one chat")
}

const terms: Operator[] = ["term", "phrase"]
export const QUERY_FIELDS: readonly MessageField[] = [
  {
    name: "text",
    example: "invoice",
    index: "message_stems ∪ message_words; wildcard and regex: message_words",
    aliases: [],
    type: "txt",
    operators: ["term", "phrase", "wildcard", "regex"],
    normalization: "Snowball 3.1.1 by script (Cyrillic, Latin; the store's searchStemmers), then v1",
    support: "A1",
  },
  {
    name: "exact",
    example: "exact:invoice",
    index: "message_words",
    aliases: [],
    type: "txt",
    operators: ["term", "phrase", "wildcard", "regex"],
    normalization: "NFKD/marks/NFC/lowercase v1",
    support: "A1",
  },
  {
    name: "body",
    example: "body:/.*invoice.*/",
    index: "messages.text / bounded postfilter",
    aliases: [],
    type: "txt",
    operators: ["term", "phrase", "wildcard", "regex"],
    normalization: "raw, case-sensitive",
    support: "A1",
  },
  {
    name: "from",
    example: 'from:"Alice Synthetic"',
    index: "identities / sender index",
    aliases: [],
    type: "kw",
    operators: terms,
    normalization: "account-scoped resolution",
    support: "A1",
  },
  ...(["to", "cc", "bcc"] as const).map(
    (name): MessageField => ({
      name,
      example: `${name}:"Alice Synthetic"`,
      index: "email_recipients",
      aliases: [],
      type: "kw",
      operators: terms,
      normalization: "account-scoped resolution; mail only",
      support: "A1",
    }),
  ),
  {
    name: "subject",
    example: 'subject:"quarterly planning"',
    index: "email_words, then the subject",
    aliases: [],
    type: "txt",
    operators: terms,
    normalization: "every word, folded as text is; mail only",
    support: "A1",
    validate: filled,
  },
  {
    name: "mailbox",
    example: 'mailbox:INBOX OR mailbox:"[Gmail]/Sent Mail"',
    index: "email_mailboxes",
    aliases: [],
    type: "kw",
    operators: terms,
    normalization: "a folder or label by its id or name, ASCII case folded; mail only",
    support: "A1",
  },
  {
    name: "label",
    example: "label:Projects",
    index: "email_mailboxes",
    aliases: [],
    type: "kw",
    operators: terms,
    normalization: "the same as mailbox:; mail only",
    support: "A1",
  },
  {
    name: "is",
    example: "is:unread",
    index: "emails.read / emails.flagged",
    aliases: [],
    type: "enum",
    operators: terms,
    normalization: "lowercase; mail only; starred is flagged; an unknown state matches neither read nor unread",
    support: "A1",
    values: ["unread", "read", "starred"],
  },
  {
    name: "chat",
    example: 'chat:"Work fixture"',
    index: "chats / message time index",
    aliases: [],
    type: "kw",
    operators: terms,
    normalization: "account-scoped resolution",
    support: "A1",
  },
  {
    name: "date",
    example: "date:[2026-01-01 TO 2026-02-01}",
    index: "messages.sent_at",
    aliases: [],
    type: "time",
    operators: [...terms, "range"],
    normalization: "ISO/calendar timezone; today, yesterday, 30m/2h/7d ago",
    support: "A1",
  },
  {
    name: "kind",
    example: "kind:private",
    index: "chats.kind / peerKind metadata",
    aliases: [],
    type: "enum",
    operators: terms,
    normalization: "lowercase",
    support: "A1",
    values: ["private", "saved", "bot", "service", "group", "channel", "unknown"],
  },
  {
    name: "has",
    example: "has:file",
    index: "attachments / messages_fts links",
    aliases: [],
    type: "enum",
    operators: terms,
    normalization: "lowercase",
    support: "A1",
    values: [
      "text",
      "attachment",
      "link",
      "file",
      "photo",
      "image",
      "video",
      "audio",
      "voice",
      "sticker",
      "contact",
      "location",
      "poll",
    ],
  },
  {
    name: "topic",
    example: "chat:7 AND topic:42",
    index: "messages.thread_native_id",
    aliases: [],
    type: "kw",
    operators: terms,
    normalization: "string id, one chat required",
    support: "A1",
    validate: validateTopic,
  },
  {
    name: "in",
    example: "in:bots",
    index: "accounts.provider",
    aliases: [],
    type: "kw",
    operators: terms,
    normalization: "lowercase provider/account class",
    support: "A1",
  },
  {
    name: "preset",
    example: "preset:secret",
    index: "bounded local candidate detector",
    aliases: [],
    type: "enum",
    operators: terms,
    normalization: "versioned candidate detector",
    support: "A1",
    values: [
      "password",
      "code",
      "api-key",
      "secret",
      "card",
      "bank",
      "passport",
      "phone",
      "email",
      "telegram-link",
      "url",
      "contact",
      "location",
    ],
  },
  {
    name: "filename",
    example: "filename:*.pdf",
    index: "attachments.name / bounded postfilter",
    aliases: [],
    type: "kw",
    operators: [...terms, "wildcard", "regex"],
    normalization: "NFKD/marks/NFC/lowercase v1, whole name",
    support: "A2",
  },
  {
    name: "mime",
    example: 'mime:"application/pdf" OR mime:image',
    index: "attachments.mime / bounded postfilter",
    aliases: [],
    type: "kw",
    operators: [...terms, "wildcard"],
    normalization: "lowercase; a value without / matches the first part; only where the messenger reports a type",
    support: "A2",
  },
  {
    name: "size",
    example: "size>10MB",
    index: "attachments.size",
    aliases: [],
    type: "kw",
    operators: [...terms, "range"],
    normalization: "bytes; KB/MB/GB are 1024-based",
    support: "A2",
    validate: validateSize,
  },
  {
    name: "content",
    example: "content:invoice",
    index: "attachment_words",
    aliases: [],
    type: "txt",
    operators: terms,
    normalization: "NFKD/marks/NFC/lowercase v1; the text of files attachments extract read or an agent wrote",
    support: "A2",
    validate: filled,
  },
  {
    name: "transcript",
    example: "transcript:invoice",
    index: "attachment_words (voice transcripts)",
    aliases: [],
    type: "txt",
    operators: terms,
    normalization: "NFKD/marks/NFC/lowercase v1; what a voice message said, as transcribed",
    support: "A2",
    validate: filled,
  },
  {
    name: "tag",
    example: "tag:work",
    index: "tags: the message, its chat or its sender",
    aliases: [],
    type: "kw",
    operators: terms,
    normalization: "lowercase a-z, 0-9 and -, 1-32 characters",
    support: "A2",
    validate: validateTag,
  },
]

const MESSAGES: QueryRegistry = { entity: "message", backend: "sql", fields: QUERY_FIELDS }

/** Field, operator and value of every term, against the message fields. */
export const validateFields = (ast: QueryAst): QueryAst => {
  for (const node of walkQuery(ast.root)) {
    const field = QUERY_FIELDS.find(({ name }) => name === node.field)
    if (!field && ["after", "before"].includes(node.field)) {
      const plain = ["term", "phrase"].includes(node.operator) && /^[\w:.+-]+$/u.test(node.value)
      searchError(
        "legacy_date_field",
        node.span,
        plain ? `use date${node.field === "after" ? ">=" : "<"}${node.value}` : "use date>=YYYY-MM-DD or date:[a TO b]",
      )
    }
    // The message compilers read `field:*` as a pattern, never as "has a value".
    if (field && node.operator === "wildcard" && !field.operators.includes("wildcard"))
      searchError("query.unsupported-operator", node.span, `${field.name} takes ${field.operators.join(", ")}`)
  }
  return validateQuery(ast, MESSAGES, SEARCH_QUERY)
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const validSpan = (value: unknown): value is Span =>
  record(value) &&
  Number.isInteger(value.start) &&
  Number.isInteger(value.end) &&
  Number(value.start) >= 0 &&
  Number(value.end) >= Number(value.start) &&
  Number(value.end) <= QUERY_LIMITS.bytes
/**
 * A query tree as JSON — MCP input and stored searches — has snake_case keys and the occur `must_not`;
 * cli-base's parser still builds `lowerInclusive`, `upperInclusive` and `mustNot`.
 */
export const astJson = (ast: QueryAst): unknown => {
  const write = (node: QueryNode): unknown => {
    if (node.kind === "boolean")
      return {
        ...node,
        clauses: node.clauses.map(({ occur, node: child }) => ({
          occur: occur === "mustNot" ? "must_not" : occur,
          node: write(child),
        })),
      }
    const { lowerInclusive, upperInclusive, ...rest } = node
    return {
      ...rest,
      ...(lowerInclusive === undefined ? {} : { lower_inclusive: lowerInclusive }),
      ...(upperInclusive === undefined ? {} : { upper_inclusive: upperInclusive }),
    }
  }
  return { ...ast, root: write(ast.root) }
}

/** Reads a query tree written as `astJson` writes it, checks its shape and limits, then its fields. */
export const validateAst = (input: unknown): QueryAst => {
  const failure = { start: 0, end: 0 }
  if (!record(input) || input.version !== 1 || input.language !== "lucene-v1")
    searchError("query.unsupported-version", failure)
  let count = 0
  let bytes = 0
  const read = (value: unknown, depth: number): QueryNode => {
    if (++count > QUERY_LIMITS.nodes || depth > QUERY_LIMITS.depth) searchError("query.too-large", failure)
    if (!record(value) || !validSpan(value.span)) searchError("query.invalid-ast", failure)
    const span = { start: value.span.start, end: value.span.end }
    if (value.kind === "boolean") {
      if (!Array.isArray(value.clauses) || value.clauses.length === 0 || value.clauses.length > QUERY_LIMITS.nodes)
        searchError("query.invalid-ast", span)
      const clauses = value.clauses.map((clause: unknown) => {
        if (!record(clause) || !["must", "should", "must_not"].includes(String(clause.occur)))
          searchError("query.invalid-ast", span)
        const occur: Occur = clause.occur === "must_not" ? "mustNot" : (clause.occur as "must" | "should")
        return { occur, node: read(clause.node, depth + 1) }
      })
      return { kind: "boolean", clauses, span }
    }
    if (
      value.kind !== "predicate" ||
      typeof value.field !== "string" ||
      typeof value.value !== "string" ||
      !["term", "phrase", "wildcard", "regex", "range"].includes(String(value.operator))
    )
      searchError("query.invalid-ast", span)
    if (value.value.length + value.field.length > QUERY_LIMITS.bytes) searchError("query.too-large", span)
    bytes += new TextEncoder().encode(value.value).length + value.field.length
    if (bytes > QUERY_LIMITS.bytes) searchError("query.too-large", span)
    const operator = value.operator as Operator
    if (
      operator === "range" &&
      (typeof value.upper !== "string" ||
        typeof value.lower_inclusive !== "boolean" ||
        typeof value.upper_inclusive !== "boolean")
    )
      searchError("query.invalid-ast", span)
    if (typeof value.upper === "string") {
      if (value.upper.length > QUERY_LIMITS.bytes) searchError("query.too-large", span)
      bytes += new TextEncoder().encode(value.upper).length
      if (bytes > QUERY_LIMITS.bytes) searchError("query.too-large", span)
    }
    return {
      kind: "predicate",
      field: value.field,
      operator,
      value: value.value,
      span,
      ...(value.implicit === true ? { implicit: true as const } : {}),
      ...(operator === "range"
        ? {
            upper: String(value.upper),
            lowerInclusive: Boolean(value.lower_inclusive),
            upperInclusive: Boolean(value.upper_inclusive),
          }
        : {}),
    }
  }
  return validateFields({ version: 1, language: "lucene-v1", root: read(input.root, 1) })
}

export const QUERY_OPERATORS = [
  {
    name: "term",
    example: "invoice",
    semantics: "Любая форма слова: text сравнивает основы Snowball; точная форма — exact:invoice или --exact",
  },
  {
    name: "phrase",
    example: '"invoice paid"',
    semantics: 'Слова подряд, в любой форме; кавычки не делают поиск точным — точная фраза: exact:"invoice paid"',
  },
  {
    name: "implicit AND",
    example: "invoice paid",
    semantics: "Оба clauses обязательны; adjacency группируется по upstream grammar",
  },
  { name: "AND / &&", example: "alpha AND beta", semantics: "Оба условия обязательны" },
  { name: "OR / ||", example: "alpha OR beta", semantics: "Любой optional clause, если нет required clause" },
  {
    name: "NOT / ! / -",
    example: "alpha NOT beta",
    semantics: "Исключить beta; чистое отрицание не выбирает весь архив",
  },
  { name: "+", example: "+alpha OR beta", semantics: "alpha обязателен, beta optional" },
  { name: "group", example: "(alpha OR beta) gamma", semantics: "Скобки фиксируют grouping" },
  { name: "field group", example: "from:(alice OR bob)", semantics: "Поле наследуется внутри группы" },
  { name: "field equality", example: "kind=group", semantics: "Стандартный синоним записи kind:group" },
  {
    name: "range",
    example: "date:[2026-01-01 TO 2026-02-01}",
    semantics: "Inclusive [ ], exclusive { }, смешанные границы и *",
  },
  {
    name: "comparison",
    example: "date>=2026-01-01",
    semantics: "Стандартный typed open range; `date:>=2026-01-01` — то же самое в записи Elasticsearch",
  },
  { name: "wildcard", example: "text:invo*", semantics: "Полный term; * — любое число символов, ? — один" },
  {
    name: "regex",
    example: "text:/pass(port)?/",
    semantics: "Полный term; bounded subset Lucene RegExp; буквы text приводятся как в индексе",
  },
  {
    name: "fuzzy / proximity",
    example: "invoice~1",
    semantics: "unsupported_operator; опечатки исправляет `--language legacy`, формы слова ловит prefix `word*`",
  },
  { name: "boost / minimum / intervals", example: "invoice^2", semantics: "query.unsupported-operator" },
] as const
