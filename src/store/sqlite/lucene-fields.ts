import { CliError } from "@wirecat/cli-base"
import { storedKinds } from "../../domain/attachments.js"
import { siteOf } from "../../domain/mentions.js"
import { tagOf } from "../../domain/tags.js"
import { type Automaton, foldRegex, type MatchBudget, wildcardPattern } from "../../search/lucene/automaton.js"
import { PRESETS } from "../../search/lucene/presets.js"
import { parseBytes } from "../../search/lucene/registry.js"
import type { QueryExecution, ResolvedPredicate } from "../../search/lucene/resolved.js"
import { isStemmed } from "../../search/lucene/resolved.js"
import { exhausted, QUERY_LIMITS, searchError } from "../../search/lucene/types.js"
import { inSource } from "../../search/query.js"
import { STEM_SEPARATOR, type Stemmer } from "../../search/stem.js"
import type { CacheDatabase, SqlValue } from "../driver.js"
import { normalize } from "../normalize.js"
import { linkMatch } from "./mention-links.js"
import { valueMatch } from "./phone-countries.js"
import { canonicalTagNamed } from "./tags.js"

export interface Fragment {
  sql: string
  params: SqlValue[]
  exact: boolean
  fts?: string
  /** The leaf as a phrase of stems, for ranking a stemmed search by `message_stems`. */
  stems?: string
  /** A bare word's other places — transcripts, file text, file names — as a set of item ids. */
  elsewhere?: { sql: string; params: SqlValue[] }
}
export interface Leaf {
  node: ResolvedPredicate
  fragment: Fragment
  test?: (text: string, attachments: string[]) => boolean
}
/** The tables one kind of searchable item lives in; the compiler names its row `m` and its thread `c`. */
export interface Corpus {
  rows: string
  threads: string
  words: string
  stems: string
  vocab: string
  item: string
  thread: string
}

/**
 * A voice note's transcript is its attachment's text, whoever wrote it: speech recognition (`speech:<model>`) or an
 * agent, which writes the text of a voice attachment as `agent`. The voice attachment is the one
 * `intoVoiceAttachment` picks.
 */
export const speech = (alias: string) =>
  `(coalesce(${alias}.extractor,'') LIKE 'speech:%' OR ${alias}.kind IN ('voice','video_note') OR coalesce(${alias}.mime,'')='audio/ogg')`
export const SPEECH = speech("att")

/**
 * What mentions are read from in an attachment: its text, or for a shared contact card its phone behind a phone
 * word, which makes the number count as a phone whatever its country code. One expression for finding and reading
 * back, so the offsets agree.
 */
export const mentionText = (alias: string) =>
  `CASE WHEN coalesce(json_extract(${alias}.contact, '$.phone'), '') <> '' THEN 'phone: ' || json_extract(${alias}.contact, '$.phone') ELSE ${alias}.text END`
export const mentionField = (alias: string) =>
  `CASE WHEN coalesce(json_extract(${alias}.contact, '$.phone'), '') <> '' THEN 'contact' WHEN ${speech(alias)} THEN 'transcript' ELSE 'file_text' END`
export const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`
/** A leaf's words as an FTS5 match: a phrase, or with `~N` its words at most N apart, in any order. */
export const ftsMatch = (node: ResolvedPredicate): string => {
  const text = normalize(node.value)
  const words = node.slop === undefined ? [] : (text.match(/[\p{L}\p{N}\p{Co}\p{M}]+/gu) ?? [])
  return words.length > 1 ? nearMatch(words, node.slop as number) : quoted(text)
}
const nearMatch = (words: string[], apart: number) => `NEAR(${words.map(quoted).join(" ")}, ${apart})`
export const combine = (parts: Fragment[], operator: "AND" | "OR"): Fragment => ({
  sql: parts.length ? `(${parts.map(({ sql }) => sql).join(` ${operator} `)})` : operator === "AND" ? "1" : "0",
  params: parts.flatMap(({ params }) => params),
  exact: parts.every(({ exact }) => exact),
})
export const prefixOf = (pattern: string): string => {
  if (pattern.includes("|")) return ""
  let prefix = ""
  for (const c of pattern) {
    if (!/[\p{L}\p{N}_ -]/u.test(c)) {
      if (["?", "*", "{"].includes(c)) prefix = [...prefix].slice(0, -1).join("")
      break
    }
    prefix += c
  }
  return prefix
}

export const wordMatch = (corpus: Corpus, match: string): Fragment => ({
  sql: `m.id IN (SELECT rowid FROM ${corpus.words} WHERE ${corpus.words} MATCH ?)`,
  params: [`normalized_text : (${match})`],
  exact: true,
  fts: match,
})
// The vocabulary is the whole store's, so a chat or date filter does not shorten it.
const tooManyWords = ({ field, operator, value, span }: ResolvedPredicate, alone: boolean): never => {
  const term = `${field}:${operator === "regex" ? `/${value}/` : value}`
  throw new CliError(
    "validation_error",
    `search: ${term}${alone ? " matches" : " and the patterns before it match"} more than ${QUERY_LIMITS.expansions} indexed words, the term expansions budget — use a longer prefix, or body:/…/ inside one chat`,
    {
      reason: "query.too-large",
      budget: "term expansions",
      complete: false,
      term,
      limit: QUERY_LIMITS.expansions,
      span,
    },
  )
}

/** What one query's leaves share while they compile: its budgets, caches and the corpus it reads. */
export interface FieldScope {
  database: CacheDatabase
  execution: QueryExecution
  corpus: Corpus
  mail: boolean
  boundedAttachments: boolean
  budget: MatchBudget
  check: () => void
  patternOf: (pattern: string, node: ResolvedPredicate) => Automaton
  expanded: Map<string, Fragment>
  attachmentWords: (match: string, which: "file" | "transcript" | "any") => { sql: string; params: SqlValue[] }
  /** The items whose voice-note transcripts a leaf matches: typed, in another form, or garbled. */
  transcripts: (node: ResolvedPredicate) => { sql: string; params: SqlValue[] }
  everywhere: (node: ResolvedPredicate, fragment: Fragment) => Fragment
  /** Counts the patterns' expanded words against the query's budget. */
  expand: (count: number) => number
}

/** A leaf's condition; a whole `Leaf` is a pattern already expanded by an earlier leaf, taken as it was. */
type Compiled = { fragment: Fragment; test?: Leaf["test"] } | Leaf
type FieldCompiler = (node: ResolvedPredicate, scope: FieldScope) => Compiled

const bound = (sql: string, ...params: SqlValue[]): Fragment => ({ sql, params, exact: true })
const always = (fragment: Fragment): Compiled => ({ fragment })
// The items whose mentions match: an email by its text; a message by its text, files and voice notes.
const mentioned = ({ mail }: FieldScope, where: string, params: SqlValue[]) =>
  mail
    ? bound(`m.id IN (SELECT mn.source_id FROM mentions mn WHERE mn.source_type='email' AND ${where})`, ...params)
    : bound(
        `m.id IN (SELECT mn.source_id FROM mentions mn WHERE mn.source_type='message' AND ${where} ` +
          "UNION SELECT a.attachable_id FROM mentions mn JOIN attachments a ON a.id=mn.source_id " +
          `AND a.attachable_type='message' WHERE mn.source_type='attachment' AND ${where})`,
        ...params,
        ...params,
      )
const stemsOf = ({ execution: { stemmer } }: FieldScope, node: ResolvedPredicate) =>
  stemmer ? stemMatch(stemmer, node) : undefined
/** A leaf as an FTS5 match over a stem index: phrases of stems, or with `~N` their `NEAR`. */
export const stemMatch = (stemmer: Stemmer, node: ResolvedPredicate): string | undefined => {
  if (node.slop === undefined) return stemmer.phrases(node.value)
  const sequences = stemmer.stemSequences(node.value).filter((sequence) => sequence.length)
  return sequences.length
    ? sequences
        .map((sequence) => (sequence.length > 1 ? nearMatch(sequence, node.slop as number) : quoted(sequence.join(""))))
        .join(" OR ")
    : undefined
}

/** Whether some stem sequence of a text holds every stem of `wanted` with at most `apart` other words between. */
const near = (sequence: string[], wanted: string[], apart: number): boolean => {
  const events = sequence.flatMap((stem, index) => (wanted.includes(stem) ? [{ index, stem }] : []))
  const held = new Map<string, number>()
  const distinct = new Set(wanted).size
  let left = 0
  for (const event of events) {
    held.set(event.stem, (held.get(event.stem) ?? 0) + 1)
    while (held.size === distinct) {
      const first = events[left] as { index: number; stem: string }
      if (event.index - first.index + 1 - distinct <= apart) return true
      const count = (held.get(first.stem) ?? 1) - 1
      if (count) held.set(first.stem, count)
      else held.delete(first.stem)
      left++
    }
  }
  return false
}

/**
 * `NEAR` over the stems can bridge `STEM_SEPARATOR`, which parts a text's Latin readings: the end of one and the
 * start of the next are one word apart. A row without the separator is the index's answer; one with it is read.
 */
const nearStems = (scope: FieldScope, node: ResolvedPredicate, stems: string): Fragment => {
  const { database, corpus, execution } = scope
  const stemmer = execution.stemmer as NonNullable<typeof execution.stemmer>
  const rows = database
    .prepare(
      `SELECT m.id AS id, m.text AS text FROM ${corpus.rows} m WHERE m.id IN (SELECT rowid FROM ${corpus.stems} WHERE ${corpus.stems} MATCH ?) LIMIT ?`,
    )
    .all(`stems : ((${stems}) AND ${quoted(STEM_SEPARATOR)})`, QUERY_LIMITS.candidates + 1)
  if (rows.length > QUERY_LIMITS.candidates) exhausted("candidate rows")
  const wanted = stemmer.stemSequences(node.value).filter((sequence) => sequence.length > 1)
  const kept = rows.flatMap(({ id, text }) => {
    scope.check()
    const sequences = stemmer.stemSequences(String(text))
    return wanted.some((query) => sequences.some((sequence) => near(sequence, query, node.slop as number)))
      ? [Number(id)]
      : []
  })
  return bound(
    `m.id IN (SELECT rowid FROM ${corpus.stems} WHERE ${corpus.stems} MATCH ?) OR m.id IN (SELECT value FROM json_each(?))`,
    `stems : ((${stems}) NOT ${quoted(STEM_SEPARATOR)})`,
    JSON.stringify(kept),
  )
}

const stemmedText: FieldCompiler = (node, scope) => {
  const { execution, corpus } = scope
  if (!execution.stemmer && !execution.unstemmed)
    throw new Error("a stemmed leaf reached the compiler without the store's stemmer")
  const text = normalize(node.value)
  const match = ftsMatch(node)
  const stems = stemsOf(scope, node)
  const byStems =
    stems && node.slop !== undefined
      ? nearStems(scope, node, stems)
      : stems
        ? bound(`m.id IN (SELECT rowid FROM ${corpus.stems} WHERE ${corpus.stems} MATCH ?)`, `stems : (${stems})`)
        : undefined
  // Words OR stems: two spellings can fold one word to different stems, and every exact hit must stay.
  return always(
    /[\p{L}\p{N}]/u.test(text)
      ? scope.everywhere(node, {
          sql: `m.id IN (SELECT rowid FROM ${corpus.words} WHERE ${corpus.words} MATCH ?)${byStems ? ` OR ${byStems.sql}` : ""}`,
          params: [`normalized_text : (${match})`, ...(byStems?.params ?? [])],
          exact: true,
          fts: match,
          ...(stems ? { stems } : {}),
        })
      : bound("0"),
  )
}

const words: FieldCompiler = (node, scope) => {
  const { operator, value } = node
  const { corpus } = scope
  if (value === "") return always(bound("0"))
  if (isStemmed(node)) return stemmedText(node, scope)
  if (operator === "term" || operator === "phrase") {
    const text = normalize(value)
    const stems = stemsOf(scope, node)
    return always(
      /[\p{L}\p{N}]/u.test(text)
        ? scope.everywhere(node, { ...wordMatch(corpus, ftsMatch(node)), ...(stems ? { stems } : {}) })
        : bound("0"),
    )
  }
  const pattern = operator === "wildcard" ? wildcardPattern(normalize(value)) : foldRegex(value, node.span)
  const automaton = scope.patternOf(pattern, node)
  const cached = scope.expanded.get(pattern)
  if (cached) return { node, fragment: cached }
  const prefix = prefixOf(pattern)
  const terms = scope.database
    .prepare(
      `SELECT term FROM ${corpus.vocab} WHERE col='normalized_text'${prefix ? " AND term>=? AND term<=?" : ""} ORDER BY term LIMIT ?`,
    )
    .all(...(prefix ? [prefix, `${prefix}\u{10ffff}`] : []), QUERY_LIMITS.expansions + 1)
  if (scope.expand(terms.length) > QUERY_LIMITS.expansions) tooManyWords(node, terms.length > QUERY_LIMITS.expansions)
  const matches = terms.flatMap(({ term }) => {
    scope.check()
    return automaton.test(String(term), scope.budget) ? [quoted(String(term))] : []
  })
  const fragment = matches.length ? wordMatch(corpus, matches.join(" OR ")) : bound("0")
  scope.expanded.set(pattern, fragment)
  return always(fragment)
}

const body: FieldCompiler = (node, scope) => {
  const { operator, value } = node
  if (value === "") return always(bound("m.text = ?", ""))
  if (operator === "term" || operator === "phrase") return always(bound("m.text = ?", value))
  const automaton = scope.patternOf(operator === "wildcard" ? wildcardPattern(value) : value, node)
  return { fragment: { sql: "1", params: [], exact: false }, test: (text) => automaton.test(text, scope.budget) }
}

const preset: FieldCompiler = ({ value }, { budget }) => ({
  fragment: { sql: "1", params: [], exact: false },
  test: (text, attachments) => {
    budget.work += text.length
    if (budget.work > QUERY_LIMITS.work) exhausted("detector work")
    return PRESETS[value.toLowerCase()]?.candidate(text, attachments) ?? false
  },
})

const attachmentColumn =
  (column: "name" | "mime"): FieldCompiler =>
  (node, scope) => {
    const { operator, value } = node
    const { database, execution, corpus, budget, boundedAttachments } = scope
    const wanted = normalize(value)
    const automaton =
      operator === "wildcard" || operator === "regex"
        ? scope.patternOf(operator === "wildcard" ? wildcardPattern(wanted) : foldRegex(value, node.span), node)
        : undefined
    const fits = (known: string) => {
      const name = normalize(known)
      budget.work += name.length
      if (budget.work > QUERY_LIMITS.work) exhausted("detector work")
      if (automaton) return automaton.test(name, budget)
      return name === wanted || (column === "mime" && !wanted.includes("/") && name.startsWith(`${wanted}/`))
    }
    let accounts = combine(
      execution.accounts.map(({ provider, account }) => bound("ac.provider=? AND ac.external_id=?", provider, account)),
      "OR",
    )
    if (boundedAttachments && execution.chat) {
      const chat = execution.chat
      accounts = combine(
        [
          accounts,
          bound(
            `ac.provider=? AND ac.external_id=? AND m.chat_id IN (SELECT id FROM ${corpus.threads} WHERE account_id=ac.id AND external_id=?)`,
            chat.account.provider,
            chat.account.account,
            chat.chatId,
          ),
        ],
        "AND",
      )
    }
    const page = database.prepare(
      `SELECT att.id AS id, att.attachable_id AS message, att.${column} AS value FROM attachments att JOIN ${corpus.rows} m ON m.id=att.attachable_id AND att.attachable_type='${corpus.item}' JOIN accounts ac ON ac.id=m.account_id WHERE att.id > ? AND att.${column} IS NOT NULL AND m.deleted_at IS NULL AND ${accounts.sql} ORDER BY att.id LIMIT 5000`,
    )
    const messages = new Set<number>()
    for (let rows = page.all(0, ...accounts.params); rows.length > 0; ) {
      scope.check()
      for (const row of rows) {
        if (fits(String(row.value))) messages.add(Number(row.message))
        if (boundedAttachments && messages.size > QUERY_LIMITS.candidates) exhausted("attachment message keys")
      }
      rows = page.all(Number(rows.at(-1)?.id), ...accounts.params)
    }
    return always(bound("m.id IN (SELECT value FROM json_each(?))", JSON.stringify([...messages])))
  }

const size: FieldCompiler = (node, { corpus }) => {
  const { operator, value } = node
  const conditions =
    operator === "range"
      ? [
          ...(value === "*"
            ? []
            : [bound(`att.size ${node.lower_inclusive ? ">=" : ">"} ?`, parseBytes(value, node.span))]),
          ...(node.upper === undefined || node.upper === "*"
            ? []
            : [bound(`att.size ${node.upper_inclusive ? "<=" : "<"} ?`, parseBytes(node.upper, node.span))]),
        ]
      : [bound("att.size = ?", parseBytes(value, node.span))]
  const range = combine(conditions, "AND")
  return always(
    bound(
      `EXISTS (SELECT 1 FROM attachments att WHERE att.attachable_type='${corpus.item}' AND att.attachable_id=m.id AND att.size IS NOT NULL AND ${range.sql})`,
      ...range.params,
    ),
  )
}

const attachmentText =
  (which: "file" | "transcript"): FieldCompiler =>
  (node, scope) => {
    const text = normalize(node.value)
    // Never `fts`: the ranking ANDs every required word into message_words, where a file's words are not.
    const set = which === "transcript" ? scope.transcripts(node) : scope.attachmentWords(ftsMatch(node), which)
    return always(/[\p{L}\p{N}]/u.test(text) ? bound(`m.id IN (${set.sql})`, ...set.params) : bound("0"))
  }

const date: FieldCompiler = (node) => {
  const range = node.resolution?.date
  if (!range) searchError("query.invalid-ast", node.span)
  const conditions: Fragment[] = []
  if (range.lower !== undefined)
    conditions.push(bound(`m.sent_at ${range.lower_inclusive ? ">=" : ">"} ?`, range.lower))
  if (range.upper !== undefined)
    conditions.push(bound(`m.sent_at ${range.upper_inclusive ? "<=" : "<"} ?`, range.upper))
  return always(combine(conditions, "AND"))
}

const chat: FieldCompiler = (node, { corpus }) => {
  const found = node.resolution?.chat
  if (!found) searchError("query.invalid-ast", node.span)
  return always(
    bound(
      `m.chat_id IN (SELECT cc.id FROM ${corpus.threads} cc JOIN accounts aa ON aa.id=cc.account_id WHERE aa.provider=? AND aa.external_id=? AND cc.external_id=?)`,
      found.account.provider,
      found.account.account,
      found.chatId,
    ),
  )
}

const from: FieldCompiler = (node) => {
  const sender = node.resolution?.sender
  if (node.resolution?.outgoing) return always(bound("m.outgoing = 1"))
  if (!sender) searchError("query.invalid-ast", node.span)
  return always(
    bound(
      "m.sender_identity_id IN (SELECT ii.id FROM identities ii WHERE ii.provider=? AND ii.external_id=?)",
      sender.provider,
      sender.id,
    ),
  )
}

const mentions: FieldCompiler = (node, scope) => {
  const [type, id = ""] = node.value.split(":")
  const pk = Number(id)
  // A person is mentioned by name, or by a phone or an address that is theirs.
  const linked: Record<string, [string, number[]]> = {
    person: [
      "(mn.target_type = 'person' AND mn.target_id = ?) OR (mn.target_type = 'identity' " +
        "AND mn.target_id IN (SELECT identity_id FROM identity_links WHERE person_id = ?))",
      [pk, pk],
    ],
    organization: [
      "mn.target_type = 'identity' AND mn.target_id IN " +
        "(SELECT identity_id FROM organization_identities WHERE organization_id = ?)",
      [pk],
    ],
    document: ["mn.target_type = 'document' AND mn.target_id = ?", [pk]],
  }
  const target = linked[type ?? ""]
  if (target === undefined) searchError("query.invalid-reference", node.span)
  return always(mentioned(scope, `mn.status = 'linked' AND (${target[0]})`, target[1]))
}

const link =
  (field: "url" | "link"): FieldCompiler =>
  ({ value }, scope) =>
    always({
      ...linkMatch(field, value, scope.mail, (where, params) => mentioned(scope, where, params)),
      exact: true,
    })

const found: FieldCompiler = ({ field, value }, scope) => {
  const match = field === "domain" ? undefined : valueMatch(scope.database, value)
  return always(
    match === undefined
      ? mentioned(scope, "mn.domain = ? AND mn.status <> 'dismissed'", [siteOf(value.toLowerCase())])
      : mentioned(scope, `mn.kind = ? AND ${match.sql} AND mn.status <> 'dismissed'`, [field, ...match.params]),
  )
}

const tag: FieldCompiler = (node, { corpus, database }) => {
  const selected = tagOf(node.value)
  if (selected === undefined) searchError("query.invalid-tag", node.span)
  const name = canonicalTagNamed(database, selected)?.name ?? selected
  return always(
    bound(
      `m.id IN (SELECT tg.taggable_id FROM taggings tg JOIN resolved_tags t ON t.id=tg.tag_id WHERE t.name=? AND tg.taggable_type='${corpus.item}') OR ` +
        `m.chat_id IN (SELECT tg.taggable_id FROM taggings tg JOIN resolved_tags t ON t.id=tg.tag_id WHERE t.name=? AND tg.taggable_type='${corpus.thread}') OR ` +
        "m.sender_identity_id IN (SELECT tg.taggable_id FROM taggings tg JOIN resolved_tags t ON t.id=tg.tag_id WHERE t.name=? AND tg.taggable_type='identity')",
      name,
      name,
      name,
    ),
  )
}

const messengerOnly =
  (compile: FieldCompiler): FieldCompiler =>
  (node, scope) => {
    if (scope.mail)
      throw new CliError(
        "validation_error",
        `search: ${node.field}: is a messenger field — mail has no ${node.field}`,
        {
          reason: "query.unsupported-field",
          span: node.span,
        },
      )
    return compile(node, scope)
  }

const topic: FieldCompiler = messengerOnly(({ value }) => always(bound("m.thread_external_id = ?", value)))

const kind: FieldCompiler = messengerOnly(({ value }) =>
  always(
    bound(
      "CASE WHEN json_extract(c.metadata,'$.peerKind') IN ('private','saved','bot','service','group','channel','unknown') THEN json_extract(c.metadata,'$.peerKind') WHEN c.kind='dialog' AND json_extract(c.metadata,'$.isBot')=1 THEN 'bot' WHEN c.kind='dialog' THEN 'private' ELSE c.kind END = ?",
      value.toLowerCase(),
    ),
  ),
)

const has: FieldCompiler = ({ value }, { corpus, mail }) => {
  const wanted = value.toLowerCase()
  return always(
    wanted === "text"
      ? bound("length(trim(coalesce(m.text,''))) > 0")
      : wanted === "link"
        ? bound(
            `(${mail ? "m.text LIKE '%' || ? || '%'" : "m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)"} OR EXISTS (SELECT 1 FROM attachments att WHERE att.attachable_type='${corpus.item}' AND att.attachable_id=m.id AND att.kind IN ('share','webpage')))`,
            mail ? "://" : quoted("://"),
          )
        : wanted === "attachment"
          ? bound(
              `EXISTS (SELECT 1 FROM attachments att WHERE att.attachable_type='${corpus.item}' AND att.attachable_id=m.id)`,
            )
          : bound(
              `EXISTS (SELECT 1 FROM attachments att WHERE att.attachable_type='${corpus.item}' AND att.attachable_id=m.id AND att.kind IN (${storedKinds(
                wanted,
              )
                .map(() => "?")
                .join(",")}))`,
              ...storedKinds(wanted),
            ),
  )
}

const inSourceField: FieldCompiler = ({ value }, { execution }) => {
  const source = value.toLowerCase()
  const chosen = execution.accounts.filter(({ provider }) => inSource(source, provider))
  return always(
    chosen.length
      ? combine(
          chosen.map(({ provider, account }) => bound("ac.provider=? AND ac.external_id=?", provider, account)),
          "OR",
        )
      : bound("0"),
  )
}

const recipient: FieldCompiler = (node, { mail }) => {
  const who = node.resolution?.sender
  if (!who) searchError("query.invalid-ast", node.span)
  return always(
    mail
      ? bound(
          "m.id IN (SELECT r.email_id FROM email_recipients r JOIN identities ii ON ii.id = r.identity_id WHERE r.role = ? AND ii.provider = ? AND ii.external_id = ?)",
          node.field,
          who.provider,
          who.id,
        )
      : bound("0"),
  )
}

// What a page says about itself, and whether a note is written or a file, exist for notes only.
const notesOnly: FieldCompiler = () => always(bound("0"))

const mailbox: FieldCompiler = ({ value }, { mail }) =>
  always(
    mail
      ? bound(
          // Not tied to m.account_id: a correlated subquery re-reads every mailbox link for each email (minutes on
          // 880k links), and an email only ever links to its own account's mailboxes anyway.
          `m.id IN (SELECT em.email_id FROM email_mailboxes em WHERE em.mailbox_id IN
               (SELECT b.id FROM mailboxes b WHERE lower(b.external_id) = lower(?) OR lower(b.name) = lower(?)))`,
          value,
          value,
        )
      : bound("0"),
  )

const is: FieldCompiler = ({ value }, { mail }) => {
  const state = value.toLowerCase()
  return always(
    state === "starred"
      ? bound(mail ? "m.flagged = 1" : "m.starred = 1")
      : !mail
        ? bound("0")
        : bound("m.read = ?", state === "read" ? 1 : 0),
  )
}

const subject: FieldCompiler = ({ operator, value }, { corpus, mail }) => {
  const wanted = normalize(value)
  const parts = wanted.match(/[\p{L}\p{N}]+/gu) ?? []
  if (!mail || !parts.length) return always(bound("0"))
  // The word index holds subject and body together: it narrows, the subject itself decides.
  return {
    fragment: { ...wordMatch(corpus, parts.map(quoted).join(" AND ")), exact: false },
    test: (text) => {
      const heading = normalize(text.slice(0, Math.max(0, text.indexOf("\n\n"))))
      return operator === "phrase"
        ? heading.includes(wanted)
        : parts.every((word) => new RegExp(`(^|[^\\p{L}\\p{N}])${word}`, "u").test(heading))
    },
  }
}

/** One compiler per field of `QUERY_FIELDS`, by its name: a leaf compiles by a lookup, never a branch. */
export const FIELD_COMPILERS: Readonly<Record<string, FieldCompiler>> = {
  text: words,
  exact: words,
  body,
  preset,
  filename: attachmentColumn("name"),
  mime: attachmentColumn("mime"),
  size,
  content: attachmentText("file"),
  transcript: attachmentText("transcript"),
  date,
  chat,
  from,
  mentions,
  url: link("url"),
  link: link("link"),
  phone: found,
  email: found,
  domain: found,
  tag,
  topic,
  kind,
  has,
  in: inSourceField,
  to: recipient,
  cc: recipient,
  bcc: recipient,
  title: notesOnly,
  site: notesOnly,
  lang: notesOnly,
  author: notesOnly,
  keyword: notesOnly,
  source: notesOnly,
  mailbox,
  label: mailbox,
  is,
  subject,
}
