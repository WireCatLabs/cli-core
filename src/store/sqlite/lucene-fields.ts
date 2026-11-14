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
import { fold, normalize } from "../normalize.js"
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
const tooManyWords = (
  { field, operator, value, span }: ResolvedPredicate,
  alone: boolean,
  prefix: string,
  mail: boolean,
): never => {
  const term = `${field}:${operator === "regex" ? `/${value}/` : value}`
  const spelled = operator === "wildcard" ? value.replace(/[*?]+/gu, " ").trim().split(/\s+/u)[0] : ""
  // Measured on a synthetic 1M-word vocabulary: reading every word takes 1-2 s, the whole search's time.
  const instead =
    !prefix && spelled
      ? mail
        ? `a pattern that starts with * reads every indexed word — write the start of the word: ${spelled}* (it also finds the word's other forms)`
        : `a pattern without three letters in a row reads every indexed word — write three or more between the stars, or the start of the word: ${spelled}*`
      : "use a longer prefix, or body:/…/ inside one chat"
  throw new CliError(
    "validation_error",
    `search: ${term}${alone ? " matches" : " and the patterns before it match"} more than ${QUERY_LIMITS.expansions} indexed words, the term expansions budget — ${instead}`,
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
  /** With `start`, a word's start: every word in a file, a transcript or a file name that begins so. */
  everywhere: (node: ResolvedPredicate, fragment: Fragment, start?: string) => Fragment
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

/** A wildcard value's literal parts, split at its unescaped `*` and `?`. */
const literalRuns = (value: string): string[] => {
  const runs = [""]
  const chars = [...value]
  for (let at = 0; at < chars.length; at++) {
    const c = chars[at] as string
    if (c === "\\") runs[runs.length - 1] += chars[++at] ?? ""
    else if (c === "*" || c === "?") runs.push("")
    else runs[runs.length - 1] += c
  }
  return runs.filter(Boolean)
}
const MOST_YO_SPELLINGS = 64
/** Every spelling of `run` with each е or ё as either: the trigram index keeps the text as written. */
const yoSpellings = (run: string): string[] | undefined => {
  let spellings = [""]
  for (const c of run) {
    spellings = spellings.flatMap((start) => (c === "е" || c === "ё" ? [`${start}е`, `${start}ё`] : [`${start}${c}`]))
    if (spellings.length > MOST_YO_SPELLINGS) return undefined
  }
  return spellings
}

/**
 * A pattern with no start to read the word list from (`*договор*`, `*ость`), in chat messages: the trigram index of
 * their text finds where its longest part occurs, so a large store does not refuse it: the whole search took 0.5–1 s at
 * 1M messages (cli-testing performance/search/infix-chat-text). `*part*` is answered by the index alone; any other shape is
 * checked word by word. It folds case, not accents: the part matches as typed, ё and е either way.
 */
const insideWords = (node: ResolvedPredicate, automaton: Automaton, scope: FieldScope): Compiled | undefined => {
  const typed = node.value.normalize("NFC").toLowerCase()
  const [longest = ""] = literalRuns(typed).sort((a, b) => [...b].length - [...a].length)
  const spellings = [...longest].length >= 3 ? yoSpellings(longest) : undefined
  if (!spellings) return undefined
  const fragment = bound(
    "m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)",
    spellings.map(quoted).join(" OR "),
  )
  if (/^\*+[\p{L}\p{N}]+\*+$/u.test(typed)) return always(fragment)
  return {
    fragment: { ...fragment, exact: false },
    test: (text) => (normalize(text).match(/[\p{L}\p{N}]+/gu) ?? []).some((word) => automaton.test(word, scope.budget)),
  }
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
  // A bare word's start reads where a bare word does: transcripts, file text and file names too.
  const start =
    operator === "wildcard" && node.implicit ? /^([\p{L}\p{N}]+)\*$/u.exec(normalize(value))?.[1] : undefined
  const widened = (fragment: Fragment) => (start ? scope.everywhere(node, fragment, start) : fragment)
  const cached = scope.expanded.get(pattern)
  if (cached) return { node, fragment: widened(cached) }
  const prefix = prefixOf(pattern)
  if (!scope.mail && operator === "wildcard" && [...prefix].length < 3) {
    const inside = insideWords(node, automaton, scope)
    if (inside) return inside
  }
  const terms = scope.database
    .prepare(
      `SELECT term FROM ${corpus.vocab} WHERE col='normalized_text'${prefix ? " AND term>=? AND term<=?" : ""} ORDER BY term LIMIT ?`,
    )
    .all(...(prefix ? [prefix, `${prefix}\u{10ffff}`] : []), QUERY_LIMITS.expansions + 1)
  if (scope.expand(terms.length) > QUERY_LIMITS.expansions) {
    if (node.widened) {
      scope.expand(-terms.length)
      const { widened: _, ...typed } = node
      return words({ ...typed, operator: "term", value: node.value.replace(/\*$/u, "") }, scope)
    }
    tooManyWords(node, terms.length > QUERY_LIMITS.expansions, prefix, scope.mail)
  }
  const matches = terms.flatMap(({ term }) => {
    scope.check()
    return automaton.test(String(term), scope.budget) ? [quoted(String(term))] : []
  })
  const fragment = matches.length ? wordMatch(corpus, matches.join(" OR ")) : bound("0")
  scope.expanded.set(pattern, fragment)
  return always(widened(fragment))
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
    if (node.operator === "wildcard") {
      // FTS5 finds a word by its start in the index itself; any other pattern would read every word of every file.
      const start = /^([\p{L}\p{N}]+)\*$/u.exec(text)?.[1]
      if (start === undefined)
        searchError(
          "query.unsupported-operator",
          node.span,
          `${node.field}: takes a word's start only, e.g. ${node.field}:invoice*`,
        )
      const set = scope.attachmentWords(`${quoted(start)} *`, which)
      return always(bound(`m.id IN (${set.sql})`, ...set.params))
    }
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

const tag: FieldCompiler = (node, scope) => {
  const { corpus, database } = scope
  const names =
    node.operator === "wildcard"
      ? tagsFitting(node, scope)
      : [canonicalTagNamed(database, tagNamed(node))?.name ?? tagNamed(node)]
  const named = "t.name IN (SELECT value FROM json_each(?))"
  const list = JSON.stringify(names)
  return always(
    bound(
      `m.id IN (SELECT tg.taggable_id FROM taggings tg JOIN resolved_tags t ON t.id=tg.tag_id WHERE ${named} AND tg.taggable_type='${corpus.item}') OR ` +
        `m.chat_id IN (SELECT tg.taggable_id FROM taggings tg JOIN resolved_tags t ON t.id=tg.tag_id WHERE ${named} AND tg.taggable_type='${corpus.thread}') OR ` +
        `m.sender_identity_id IN (SELECT tg.taggable_id FROM taggings tg JOIN resolved_tags t ON t.id=tg.tag_id WHERE ${named} AND tg.taggable_type='identity')`,
      list,
      list,
      list,
    ),
  )
}
const tagNamed = (node: ResolvedPredicate): string => {
  const selected = tagOf(node.value)
  if (selected === undefined) searchError("query.invalid-tag", node.span)
  return selected
}
const tagsFitting = (node: ResolvedPredicate, scope: FieldScope): string[] => {
  const automaton = scope.patternOf(wildcardPattern(node.value.toLowerCase()), node)
  return scope.database
    .prepare("SELECT DISTINCT name FROM resolved_tags")
    .all()
    .map(({ name }) => String(name))
    .filter((name) => automaton.test(name, scope.budget))
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

/** What `kind:` matches for a chat aliased `c`: private, saved, bot, service, group, channel or unknown. */
export const PEER_KIND =
  "CASE WHEN json_extract(c.metadata,'$.peerKind') IN ('private','saved','bot','service','group','channel','unknown') THEN json_extract(c.metadata,'$.peerKind') WHEN c.kind='dialog' AND json_extract(c.metadata,'$.isBot')=1 THEN 'bot' WHEN c.kind='dialog' THEN 'private' ELSE c.kind END"

const kind: FieldCompiler = messengerOnly(({ value }) => always(bound(`${PEER_KIND} = ?`, value.toLowerCase())))

/** How many people a chat has, as the messenger last said; a chat with no known size matches no value. */
const participantsCount: FieldCompiler = messengerOnly((node) => {
  const { operator, value, upper } = node
  const column = "c.participants_count"
  if (operator !== "range") return always(bound(`${column} = ?`, Number(value)))
  const conditions = [
    ...(value === "*" ? [] : [bound(`${column} ${node.lower_inclusive ? ">=" : ">"} ?`, Number(value))]),
    ...(upper === undefined || upper === "*"
      ? []
      : [bound(`${column} ${node.upper_inclusive ? "<=" : "<"} ?`, Number(upper))]),
  ]
  return always(combine(conditions, "AND"))
})

/** A chat the owner muted, until its mute runs out; a chat whose messenger keeps no mute is not muted. */
const muted: FieldCompiler = messengerOnly(({ value }) =>
  always(
    bound(
      `${value.toLowerCase() === "true" ? "" : "NOT "}(coalesce(c.muted, 0) = 1 AND (c.muted_until IS NULL OR c.muted_until > ?))`,
      Date.now(),
    ),
  ),
)

const has: FieldCompiler = ({ value }, { corpus, mail }) => {
  const wanted = value.toLowerCase()
  if (wanted === "transcript")
    return always(bound(mail ? "0" : "EXISTS (SELECT 1 FROM message_transcripts t WHERE t.message_id = m.id)"))
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
const notesOnly: FieldCompiler = (node) =>
  searchError(
    "query.unsupported-field",
    node.span,
    `${node.field}: is a notes field — search notes reads it${node.field === "author" ? "; who wrote a message is from:" : ""}`,
  )

const mailbox: FieldCompiler = (node, scope) => {
  const { value, operator } = node
  if (!scope.mail) return always(bound("0"))
  if (operator === "wildcard") {
    // A store holds tens of mailboxes: every one is read and the pattern tried on its id and its name.
    const automaton = scope.patternOf(wildcardPattern(fold(value)), node)
    const ids = scope.database
      .prepare("SELECT id, external_id, name_folded FROM mailboxes")
      .all()
      .filter((row) =>
        [fold(String(row.external_id)), String(row.name_folded ?? "")].some((one) => automaton.test(one, scope.budget)),
      )
      .map(({ id }) => Number(id))
    return always(
      bound(
        "m.id IN (SELECT em.email_id FROM email_mailboxes em WHERE em.mailbox_id IN (SELECT value FROM json_each(?)))",
        JSON.stringify(ids),
      ),
    )
  }
  return always(
    bound(
      // Not tied to m.account_id: a correlated subquery re-reads every mailbox link for each email (minutes on
      // 880k links), and an email only ever links to its own account's mailboxes anyway.
      `m.id IN (SELECT em.email_id FROM email_mailboxes em WHERE em.mailbox_id IN
               (SELECT b.id FROM mailboxes b WHERE lower(b.external_id) = lower(?) OR b.name_folded = ?))`,
      value,
      fold(value),
    ),
  )
}

// Mail stored in full keeps List-Id in its headers; mail only recorded, in its metadata.
const list: FieldCompiler = ({ value }, { mail }) => {
  const wanted = value.trim().toLowerCase()
  return always(
    mail
      ? bound(
          `m.id IN (SELECT id FROM (SELECT id, coalesce(json_extract(headers, '$."list-id"'),
             json_extract(metadata, '$.listId')) AS list_id FROM emails) WHERE list_id = ? OR list_id LIKE '%.' || ? ESCAPE '\\')`,
          wanted,
          wanted.replace(/[\\%_]/g, "\\$&"),
        )
      : bound("0"),
  )
}

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

const subject: FieldCompiler = (node, scope) => {
  const { operator, value } = node
  const { corpus, mail } = scope
  const wanted = normalize(value)
  const parts = wanted.match(/[\p{L}\p{N}]+/gu) ?? []
  if (!mail || !parts.length) return always(bound("0"))
  if (operator === "wildcard") {
    // The word index holds a mailbox's every word: a pattern without a start would read all of them.
    const pattern = wildcardPattern(wanted)
    const start = prefixOf(pattern)
    if (!start)
      searchError("query.unsupported-operator", node.span, "subject: takes a word's start, e.g. subject:invoice*")
    const automaton = scope.patternOf(pattern, node)
    return {
      fragment: { ...wordMatch(corpus, `${quoted(start)} *`), exact: false },
      test: (text) =>
        (headingOf(text).match(/[\p{L}\p{N}]+/gu) ?? []).some((word) => automaton.test(word, scope.budget)),
    }
  }
  // The word index holds subject and body together: it narrows, the subject itself decides.
  return {
    fragment: { ...wordMatch(corpus, parts.map(quoted).join(" AND ")), exact: false },
    test: (text) => {
      const heading = headingOf(text)
      return operator === "phrase"
        ? heading.includes(wanted)
        : parts.every((word) => new RegExp(`(^|[^\\p{L}\\p{N}])${word}`, "u").test(heading))
    },
  }
}

const headingOf = (text: string) => normalize(text.slice(0, Math.max(0, text.indexOf("\n\n"))))

// One concept, one name: a message's title is its chat's, a mail's is its subject.
const title: FieldCompiler = (node, scope) => {
  if (scope.mail) return subject(node, scope)
  const wanted = fold(node.value)
  const parts = node.operator === "phrase" ? [wanted] : (wanted.match(/[\p{L}\p{N}]+/gu) ?? [])
  if (!parts.length) return always(bound("0"))
  return always(
    combine(
      parts.map((part) => bound("instr(c.title_folded, ?) > 0", part)),
      "AND",
    ),
  )
}

const SUBJECT_PRESENT = "substr(m.text, 1, 2) <> char(10, 10)"
/** `field:*` of a field in `PRESENCE`: the message or mail has a value there. */
export const present: FieldCompiler = (node, scope) => {
  const { field } = node
  if (field === "topic") return messengerOnly(() => always(bound("m.thread_external_id IS NOT NULL")))(node, scope)
  if (field === "participants_count")
    return messengerOnly(() => always(bound("c.participants_count IS NOT NULL")))(node, scope)
  if (field === "from") return always(bound("m.sender_identity_id IS NOT NULL"))
  if (!scope.mail) return always(bound(field === "title" ? "coalesce(c.title, '') <> ''" : "0"))
  if (field === "title" || field === "subject") return always(bound(SUBJECT_PRESENT))
  return always(bound("m.id IN (SELECT r.email_id FROM email_recipients r WHERE r.role = ?)", field))
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
  muted,
  participants_count: participantsCount,
  has,
  in: inSourceField,
  to: recipient,
  cc: recipient,
  bcc: recipient,
  title,
  site: notesOnly,
  lang: notesOnly,
  author: notesOnly,
  keyword: notesOnly,
  source: notesOnly,
  mailbox,
  label: mailbox,
  list,
  is,
  subject,
}
