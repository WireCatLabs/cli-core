import {
  type FieldSpec,
  type Operator,
  type Predicate,
  type QueryAst,
  type QueryRegistry,
  queryAstSchema,
  type Span,
  validateQuery,
  walkQuery,
} from "@wirecat/cli-base/query"
import * as v from "valibot"
import { tagOf } from "../../domain/tags.js"
import { MOST_WORDS_APART, QUERY_LIMITS, SEARCH_QUERY, searchError } from "./types.js"

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
const validateMentioned = (node: Predicate): void => {
  if (!/^(?:person|organization|document):[1-9]\d*$/u.test(node.value))
    searchError("query.invalid-reference", node.span, "use person:<uid>, organization:<id> or document:<id>, quoted")
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
    normalization: "Snowball 3.1.1 by script (Cyrillic, Latin; the store's search_stemmers), then v1",
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
    normalization: "a folder or label by its id (ASCII case folded) or name (case folded in any script); mail only",
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
    index: "emails.read / emails.flagged / messages.starred",
    aliases: [],
    type: "enum",
    operators: terms,
    normalization:
      "lowercase; read and unread are mail only; starred is a flagged email or a message the owner starred; an unknown state matches neither read nor unread",
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
    name: "source",
    example: "source:internal",
    index: "notes (internal) / documents (file)",
    aliases: [],
    type: "enum",
    operators: terms,
    normalization: "lowercase; notes only: internal is written in memo, file is from a notes folder",
    support: "A1",
    values: ["internal", "file"],
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
    index: "attachment_words ∪ transcript_stems; garbled spellings from transcript_words_vocab",
    aliases: [],
    type: "txt",
    operators: terms,
    normalization:
      "any form of the word (Snowball), widened to spellings speech recognition garbles; what a voice message said",
    support: "A2",
    validate: filled,
  },
  ...(
    [
      [
        "title",
        'title:"quarterly report"',
        "documents.metadata, then the title column",
        "every word, folded as text is; notes and files only",
        "txt",
      ],
      [
        "site",
        "site:wikipedia",
        "documents.metadata (og:site_name)",
        "contained, folded as text is; notes and files only",
        "kw",
      ],
      [
        "lang",
        "lang:ru",
        "documents.metadata (html lang)",
        "language tag or its prefix, lowercase; notes and files only",
        "kw",
      ],
      [
        "author",
        "author:ivanov",
        "documents.metadata (meta author, JSON-LD)",
        "contained, folded as text is; notes and files only",
        "kw",
      ],
      [
        "keyword",
        "keyword:invoices",
        "documents.metadata (meta keywords)",
        "whole keyword, folded as text is; notes and files only",
        "kw",
      ],
    ] as const
  ).map(([name, example, index, normalization, type]) => ({
    name,
    example,
    index,
    aliases: [],
    type,
    operators: terms,
    normalization,
    support: "A2" as const,
    validate: filled,
  })),
  ...(
    [
      [
        "phone",
        'phone:"8 900 000-00-01"',
        "a phone found in the text, written any way; a number without + is read in phone_countries",
      ],
      ["email", "email:ana@example.com", "an address found in the text, lower-cased"],
      ["url", 'url:"https://example.com/a"', "a link found in the text, without utm_*, fbclid and the fragment"],
      ["domain", "domain:google.com", "the site of a link or an address in the text; docs.google.com means google.com"],
      [
        "link",
        'link:"click?id=1"',
        "a part of a link, quoted; Latin letters in any case; in mail also the body of a letter with a tracking link",
      ],
    ] as const
  ).map(([name, example, normalization]) => ({
    name,
    example,
    index: "mentions (kind, value) / (domain); in mail a tracking link is kept as its site",
    aliases: [],
    type: "kw" as const,
    operators: terms,
    normalization,
    support: "A2" as const,
    validate: filled,
  })),
  {
    name: "mentions",
    example: 'mentions:"person:12"',
    index: "mentions (target_type, target_id)",
    aliases: [],
    type: "kw" as const,
    operators: terms,
    normalization: "a person (by name, phone or address), an organization or a document, linked; quoted",
    support: "A2" as const,
    validate: validateMentioned,
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

const NEAR_FIELDS = new Set(["text", "exact", "transcript", "content"])
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
    if (node.slop !== undefined && !NEAR_FIELDS.has(node.field))
      searchError("query.unsupported-operator", node.span, `"a b"~N takes words: ${[...NEAR_FIELDS].join(", ")}`)
    if (node.slop !== undefined && node.slop > MOST_WORDS_APART)
      searchError(
        "query.invalid-number",
        node.span,
        `words at most ${MOST_WORDS_APART} apart: "a b"~${MOST_WORDS_APART}`,
      )
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
/** Checks a received query tree — MCP input, a stored search — against cli-base's schema, the limits, then its fields. */
export const validateAst = (input: unknown): QueryAst => {
  const failure = { start: 0, end: 0 }
  if (!record(input) || input.version !== 1 || input.language !== "lucene-v1")
    searchError("query.unsupported-version", failure)
  let count = 0
  let bytes = 0
  // Before the schema: its recursion has no depth bound.
  const measure = (value: unknown, depth: number): void => {
    if (++count > QUERY_LIMITS.nodes || depth > QUERY_LIMITS.depth) searchError("query.too-large", failure)
    if (!record(value) || !validSpan(value.span)) searchError("query.invalid-ast", failure)
    if (Array.isArray(value.clauses)) {
      if (value.clauses.length === 0) searchError("query.invalid-ast", value.span)
      for (const clause of value.clauses) measure(record(clause) ? clause.node : undefined, depth + 1)
      return
    }
    for (const text of [value.field, value.value, value.upper])
      if (typeof text === "string") bytes += new TextEncoder().encode(text).length
    if (bytes > QUERY_LIMITS.bytes) searchError("query.too-large", value.span)
  }
  measure(input.root, 1)
  const parsed = v.safeParse(queryAstSchema, input)
  if (!parsed.success) searchError("query.invalid-ast", failure)
  const open = walkQuery(parsed.output.root).find(
    (node) =>
      node.operator === "range" &&
      (node.upper === undefined || node.lower_inclusive === undefined || node.upper_inclusive === undefined),
  )
  if (open) searchError("query.invalid-ast", open.span)
  return validateFields(parsed.output)
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
    name: "proximity",
    example: '"invoice paid"~3',
    semantics: "Слова одного сообщения, между ними не больше N других слов, в любом порядке; N до 50",
  },
  { name: "fuzzy", example: "invoice~1", semantics: "unsupported_operator; формы слова ловит prefix `word*`" },
  { name: "boost / minimum / intervals", example: "invoice^2", semantics: "query.unsupported-operator" },
] as const
