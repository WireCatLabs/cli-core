import { CliError } from "@wirecat/cli-base"
import { tagOf } from "../../domain/tags.js"
import {
  type Automaton,
  compileAutomaton,
  foldRegex,
  type MatchBudget,
  wildcardPattern,
} from "../../search/lucene/automaton.js"
import type { ResolvedNode, ResolvedPredicate } from "../../search/lucene/resolved.js"
import { isStemmed } from "../../search/lucene/resolved.js"
import { exhausted, QUERY_LIMITS, searchError } from "../../search/lucene/types.js"
import type { Stemmer } from "../../search/stem.js"
import type { SqlValue } from "../driver.js"
import { normalize } from "../normalize.js"
import { contextDocumentTime } from "./context-document-source.js"
import { type DocumentPictureStore, documentPicturesOver } from "./document-pictures.js"
import { linkKind } from "./link-kinds.js"
import { prefixOf } from "./lucene.js"
import { drainNoteIndex, type NoteIndexState, noteIndexState, noteIndexText } from "./note-index.js"
import { documentOf, type Note, noteOf } from "./notes.js"
import type { StoreContext } from "./open.js"
import { stemmerCache } from "./stems.js"
import { canonicalTagNamed } from "./tags.js"
import { read } from "./transaction.js"
import { searchIndex } from "./vector-index.js"
import { dot } from "./vectors.js"

export interface NoteQuery {
  root: ResolvedNode
  limit: number
  offset?: number
  folderIds?: string[]
  /** With `folderIds`, the notes written in memo too, in the same ranked list. */
  withInternal?: boolean
  source?: Note["source"]
  /** Only these notes (`document:<id>`, `note:<id>`): checks a list found another way against the query. */
  refs?: string[]
  /** Newest first instead of best first. */
  newest?: boolean
  /** The store's stemmer, set when a leaf is stemmed. */
  stemmer?: Stemmer
  signal?: AbortSignal
}

export interface NoteHit {
  ref: string
  note: Note
  /** bm25 of the words or stems; lower is better. `null` when ranked by time. */
  relevance: number | null
  /** Whether the note holds the exact forms, when the search was stemmed. */
  exact?: boolean
  /** The time `date:` read: a Drive document's edit time when the store has one, else when the store's copy changed. */
  at: string
}

/** The fields a note has. A message-only field (`from:`, `chat:`, …) is refused rather than matching nothing. */
export const NOTE_FIELDS = [
  "text",
  "exact",
  "body",
  "tag",
  "date",
  "in",
  "has",
  "title",
  "site",
  "lang",
  "author",
  "keyword",
  "source",
] as const

interface Fragment {
  sql: string
  params: SqlValue[]
  /** False when the SQL only narrows the candidates and a JS test decides. */
  exact: boolean
  fts?: string
  stems?: string
}

const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`
const bound = (sql: string, ...params: SqlValue[]): Fragment => ({ sql, params, exact: true })
const combine = (parts: Fragment[], operator: "AND" | "OR"): Fragment => ({
  sql: parts.length ? `(${parts.map(({ sql }) => sql).join(` ${operator} `)})` : operator === "AND" ? "1" : "0",
  params: parts.flatMap(({ params }) => params),
  exact: parts.every(({ exact }) => exact),
})
/**
 * Files in notes folders, the notes the owner wrote and calendar events: one query language, each in its own table
 * and index.
 */
export interface Corpus {
  type: "document" | "note" | "event"
  /** What a hit is called in an error and in `in:` (`in:notes`, `in:events`). */
  noun: "note" | "event"
  fields: readonly string[]
  /** The rows as `n`, with the columns the query reads under one set of names; `at` is the time `date:` reads. */
  view: string
  words: string
  stems: string
  /** The rows a search may return at all, besides `deleted_at`. */
  live?: string
  /** The rows of these accounts, as a JSON list of ids. */
  inAccounts?: (ids: string) => Fragment
  /** The tagged rows; a document is also labelled through its folder or a subfolder of it. */
  tagged?: (tag: string) => Fragment
}

const CORPORA: Corpus[] = [
  {
    type: "document",
    noun: "note",
    fields: NOTE_FIELDS,
    view: `(SELECT n.id, n.account_id AS folder_id, n.external_id AS path, n.title, coalesce(n.body, '') AS text, n.metadata, ${contextDocumentTime} AS at, n.deleted_at FROM documents n)`,
    words: "document_words",
    stems: "document_stems",
    live: "coalesce(json_extract(n.metadata, '$.catalog.active'), 1)=1",
    inAccounts: (ids) => bound("n.folder_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))", ids),
    tagged: (tag) =>
      bound(
        "(n.id IN (SELECT g.taggable_id FROM taggings g JOIN resolved_tags t ON t.id=g.tag_id WHERE t.name = ? AND g.taggable_type = 'document') " +
          "OR n.folder_id IN (SELECT g.taggable_id FROM taggings g JOIN resolved_tags t ON t.id=g.tag_id WHERE t.name = ? AND g.taggable_type = 'account') " +
          "OR EXISTS (SELECT 1 FROM links l JOIN resolved_tags t ON t.id=l.to_id WHERE l.from_type = 'account' AND l.from_id = n.folder_id " +
          `AND l.kind = ${linkKind("labelled")} AND l.to_type = 'tag' AND t.name = ? AND substr(n.path, 1, length(l.anchor) + 1) = l.anchor || '/'))`,
        tag,
        tag,
        tag,
      ),
  },
  {
    type: "note",
    noun: "note",
    fields: NOTE_FIELDS,
    view: "(SELECT id, NULL AS folder_id, NULL AS path, title, body AS text, NULL AS metadata, updated_at AS at, deleted_at FROM notes)",
    words: "note_words",
    stems: "note_stems",
    tagged: (tag) =>
      bound(
        "n.id IN (SELECT g.taggable_id FROM taggings g JOIN resolved_tags t ON t.id=g.tag_id WHERE t.name = ? AND g.taggable_type = 'note')",
        tag,
      ),
  },
]

export interface CorpusRow {
  type: Corpus["type"]
  id: number
  /** The time `date:` reads: a note's last change, an event's start. */
  at: number | null
  relevance: number | null
  exact?: boolean
}

/** What one corpus is searched by; `accountIds` narrows a corpus that has accounts. */
export type CorpusQuery = Pick<NoteQuery, "root" | "limit" | "offset" | "newest" | "stemmer" | "signal"> & {
  accountIds?: string[]
  ids?: number[]
}

/** Notes matching a parsed query, by the same language as messages: files and written notes, merged. */
export const searchNotes = (context: StoreContext, query: NoteQuery): { items: NoteHit[]; hasMore: boolean } => {
  const offset = query.offset ?? 0
  const chosen = CORPORA.filter(
    ({ type }) =>
      (query.source === undefined || (query.source === "file") === (type === "document")) &&
      (!query.folderIds?.length || query.withInternal === true || type === "document"),
  )
  const idsOf = (type: Corpus["type"]) =>
    query.refs?.flatMap((ref) => (ref.startsWith(`${type}:`) ? [Number(ref.slice(type.length + 1))] : []))
  const rows = chosen.flatMap((corpus) => {
    const ids = idsOf(corpus.type)
    if (ids?.length === 0) return []
    return searchCorpus(
      context,
      { ...query, ...(query.folderIds ? { accountIds: query.folderIds } : {}), ...(ids ? { ids } : {}) },
      corpus,
    )
  })
  const exactFirst = rows.some((row) => row.exact !== undefined)
  rows.sort((a, b) =>
    query.newest
      ? (b.at ?? 0) - (a.at ?? 0) || a.id - b.id
      : (exactFirst ? Number(b.exact === true) - Number(a.exact === true) : 0) ||
        Number(a.relevance === null) - Number(b.relevance === null) ||
        (a.relevance ?? 0) - (b.relevance ?? 0) ||
        (b.at ?? 0) - (a.at ?? 0) ||
        a.id - b.id,
  )
  const read = {
    document: context.database.prepare("SELECT * FROM documents WHERE id = ?"),
    note: context.database.prepare("SELECT * FROM notes WHERE id = ?"),
  }
  return {
    items: rows.slice(offset, offset + query.limit).map((row) => {
      const found = read[row.type === "document" ? "document" : "note"].get(row.id) as Record<string, unknown>
      const note = row.type === "document" ? documentOf(found) : noteOf(found)
      return {
        ref: note.ref,
        note,
        relevance: row.relevance,
        ...(row.exact === undefined ? {} : { exact: row.exact }),
        at: new Date(row.at ?? 0).toISOString(),
      }
    }),
    hasMore: rows.length > offset + query.limit,
  }
}

export const searchCorpus = (context: StoreContext, query: CorpusQuery, corpus: Corpus): CorpusRow[] => {
  const { database } = context
  const wordMatch = (match: string): Fragment => ({
    sql: `n.id IN (SELECT rowid FROM ${corpus.words} WHERE ${corpus.words} MATCH ?)`,
    params: [`normalized_text : (${match})`],
    exact: true,
    fts: match,
  })
  const started = context.now()
  const budget: MatchBudget = { work: 0 }
  let expansions = 0
  const check = () => {
    if (query.signal?.aborted)
      throw new CliError("validation_error", "search was aborted", { reason: "query.aborted", complete: false })
    if (context.now() - started > QUERY_LIMITS.milliseconds) exhausted("time")
  }
  const tests = new Map<ResolvedPredicate, (text: string) => boolean>()
  const fragments = new Map<ResolvedPredicate, Fragment>()
  const automaton = (pattern: string, node: ResolvedPredicate): Automaton => compileAutomaton(pattern, node.span)
  // SQLite's lower() folds ASCII only, and Bun cannot register a function that folds the rest, so titles fold here.
  let titles: { id: number; title: string }[] | undefined
  const foldedTitles = () =>
    (titles ??= database
      .prepare(`SELECT id, title FROM ${corpus.view} n WHERE n.title IS NOT NULL AND n.deleted_at IS NULL`)
      .all()
      .map((row) => ({ id: Number(row.id), title: normalize(String(row.title)) })))

  const leaf = (node: ResolvedPredicate): Fragment => {
    const { field, operator, value } = node
    if (!corpus.fields.includes(field))
      searchError(
        "query.unsupported-field",
        node.span,
        `${field}: is not ${corpus.noun === "event" ? "an" : "a"} ${corpus.noun} field — ${corpus.noun}s take ${corpus.fields.join(", ")}`,
      )
    if ((field === "text" || field === "exact") && value === "") return bound("0")
    if (isStemmed(node)) {
      if (!query.stemmer) throw new Error("a stemmed leaf reached the notes search without the store's stemmer")
      const text = normalize(value)
      if (!/[\p{L}\p{N}]/u.test(text)) return bound("0")
      const stems = query.stemmer.phrases(value)
      return {
        sql: `n.id IN (SELECT rowid FROM ${corpus.words} WHERE ${corpus.words} MATCH ?)${stems ? ` OR n.id IN (SELECT rowid FROM ${corpus.stems} WHERE ${corpus.stems} MATCH ?)` : ""}`,
        params: [`normalized_text : (${quoted(text)})`, ...(stems ? [`stems : (${stems})`] : [])],
        exact: true,
        fts: quoted(text),
        ...(stems ? { stems } : {}),
      }
    }
    if (field === "text" || field === "exact") {
      if (operator === "term" || operator === "phrase") {
        const text = normalize(value)
        const stems = query.stemmer?.phrases(value)
        return /[\p{L}\p{N}]/u.test(text) ? { ...wordMatch(quoted(text)), ...(stems ? { stems } : {}) } : bound("0")
      }
      const pattern = operator === "wildcard" ? wildcardPattern(normalize(value)) : foldRegex(value, node.span)
      const matcher = automaton(pattern, node)
      const prefix = prefixOf(pattern)
      const terms = database
        .prepare(
          `SELECT term FROM ${corpus.words}_vocab WHERE col='normalized_text'${prefix ? " AND term>=? AND term<=?" : ""} ORDER BY term LIMIT ?`,
        )
        .all(...(prefix ? [prefix, `${prefix}\u{10ffff}`] : []), QUERY_LIMITS.expansions + 1)
      expansions += terms.length
      if (expansions > QUERY_LIMITS.expansions) exhausted("term expansions")
      const matches = terms.flatMap(({ term }) => {
        check()
        return matcher.test(String(term), budget) ? [quoted(String(term))] : []
      })
      return matches.length ? wordMatch(matches.join(" OR ")) : bound("0")
    }
    if (field === "body") {
      if (operator === "term" || operator === "phrase") return bound("n.text = ?", value)
      const matcher = automaton(operator === "wildcard" ? wildcardPattern(value) : value, node)
      tests.set(node, (text) => matcher.test(text, budget))
      return { sql: "1", params: [], exact: false }
    }
    if (field === "tag") {
      const tag = tagOf(value)
      if (tag === undefined) searchError("query.invalid-tag", node.span)
      // A label on a folder or subfolder labels every note under it, at any depth.
      return corpus.tagged?.(canonicalTagNamed(database, tag)?.name ?? tag) ?? bound("0")
    }
    if (field === "source")
      return bound(value.toLowerCase() === (corpus.type === "note" ? "internal" : "file") ? "1" : "0")
    if (field === "has") {
      // A document drive could not read is kept by its name alone; `-has:text` lists those.
      if (value.toLowerCase() !== "text")
        searchError("query.unknown-value", node.span, `has:${value} is a message field — notes take has:text`)
      return bound("length(trim(coalesce(n.text,''))) > 0")
    }
    if (field === "title" || field === "site" || field === "lang" || field === "author" || field === "keyword") {
      const wanted = normalize(value)
      if (wanted === "") return bound("0")
      const folded = (key: string) => `coalesce(json_extract(n.metadata, '$.folded.${key}'), '')`
      if (field === "keyword")
        return bound("EXISTS (SELECT 1 FROM json_each(n.metadata, '$.folded.keywords') WHERE value = ?)", wanted)
      if (field === "lang")
        return bound(`(${folded("language")} = ? OR ${folded("language")} LIKE ? || '-%')`, wanted, wanted)
      if (field === "title") {
        check()
        const ids = foldedTitles().flatMap(({ id, title }) => (title.includes(wanted) ? [id] : []))
        return bound(
          `(instr(${folded("title")}, ?) > 0 OR n.id IN (SELECT value FROM json_each(?)))`,
          wanted,
          JSON.stringify(ids),
        )
      }
      return bound(`instr(${folded(field)}, ?) > 0`, wanted)
    }
    if (field === "date") {
      const range = node.resolution?.date
      if (!range) searchError("query.invalid-ast", node.span)
      return combine(
        [
          ...(range.lower === undefined ? [] : [bound(`n.at ${range.lower_inclusive ? ">=" : ">"} ?`, range.lower)]),
          ...(range.upper === undefined ? [] : [bound(`n.at ${range.upper_inclusive ? "<=" : "<"} ?`, range.upper)]),
        ],
        "AND",
      )
    }
    return bound([corpus.noun, `${corpus.noun}s`].includes(value.toLowerCase()) ? "1" : "0")
  }

  const compile = (node: ResolvedNode): Fragment => {
    if (node.kind === "predicate") {
      const fragment = leaf(node)
      const wrapped = { ...fragment, sql: `(${fragment.sql})` }
      fragments.set(node, wrapped)
      return wrapped
    }
    const parts = node.clauses.map(({ occur, node }) => ({ occur, part: compile(node) }))
    const must = parts.filter(({ occur }) => occur === "must").map(({ part }) => part)
    const should = parts.filter(({ occur }) => occur === "should").map(({ part }) => part)
    const not = parts
      .filter(({ occur }) => occur === "must_not")
      .map(({ part }) =>
        part.exact ? { ...part, sql: `NOT coalesce(${part.sql},0)` } : { sql: "1", params: [], exact: false },
      )
    return combine([must.length ? combine(must, "AND") : combine(should, "OR"), ...not], "AND")
  }
  const required = (node: ResolvedNode, index: "fts" | "stems"): string | undefined => {
    if (node.kind === "predicate") return fragments.get(node)?.[index]
    const must = node.clauses.filter(({ occur }) => occur === "must")
    const parts = (must.length ? must : node.clauses.filter(({ occur }) => occur === "should")).map(({ node }) =>
      required(node, index),
    )
    if (must.length) {
      const known = parts.filter((part): part is string => part !== undefined)
      return known.length ? known.map((part) => `(${part})`).join(" AND ") : undefined
    }
    return parts.length && parts.every((part) => part !== undefined)
      ? parts.map((part) => `(${part})`).join(" OR ")
      : undefined
  }

  return read(database, () => {
    check()
    const expression = compile(query.root)
    const stemmed = [...fragments.keys()].some(isStemmed)
    const scope = combine(
      [
        bound("n.deleted_at IS NULL"),
        ...(corpus.live ? [bound(corpus.live)] : []),
        ...(query.accountIds?.length && corpus.inAccounts ? [corpus.inAccounts(JSON.stringify(query.accountIds))] : []),
        ...(query.ids ? [bound("n.id IN (SELECT value FROM json_each(?))", JSON.stringify(query.ids))] : []),
      ],
      "AND",
    )
    const where = combine([scope, expression], "AND")
    const ranking = query.newest ? undefined : required(query.root, stemmed ? "stems" : "fts")
    const exactTier = stemmed ? required(query.root, "fts") : undefined
    const ctes: string[] = []
    const cteParams: SqlValue[] = []
    if (ranking) {
      const table = stemmed ? corpus.stems : corpus.words
      ctes.push(
        `f(id, rank) AS MATERIALIZED (SELECT rowid, bm25(${table}, 1.0, 0.0) FROM ${table} WHERE ${table} MATCH ?)`,
      )
      cteParams.push(`${stemmed ? "stems" : "normalized_text"} : (${ranking})`)
    }
    if (exactTier) {
      ctes.push(`x(id) AS MATERIALIZED (SELECT rowid FROM ${corpus.words} WHERE ${corpus.words} MATCH ?)`)
      cteParams.push(`normalized_text : (${exactTier})`)
    }
    const order = query.newest
      ? "n.at DESC, n.id"
      : `${exactTier ? "exact DESC, " : ""}${ranking ? "f.rank IS NULL, f.rank, " : ""}n.at DESC, n.id`
    const offset = query.offset ?? 0
    // With a JS test the SQL only names candidates: every leaf's SQL answer comes along, so the test sees it.
    const leaves = [...fragments.entries()].filter(([node]) => !tests.has(node))
    const projection = tests.size
      ? leaves.map(([, fragment], index) => `, coalesce(${fragment.sql}, 0) AS q${index}`).join("")
      : ""
    const window = tests.size ? QUERY_LIMITS.candidates + 1 : query.limit + offset + 1
    const rows = database
      .prepare(
        `${ctes.length ? `WITH ${ctes.join(", ")} ` : ""}SELECT n.*, ${ranking ? "f.rank" : "NULL"} AS relevance${exactTier ? ", n.id IN (SELECT id FROM x) AS exact" : ""}${projection}
           FROM ${corpus.view} n${ranking ? " LEFT JOIN f ON f.id = n.id" : ""} WHERE ${where.sql} ORDER BY ${order} LIMIT ?`,
      )
      .all(
        ...cteParams,
        ...leaves.flatMap(([, fragment]) => (tests.size ? fragment.params : [])),
        ...where.params,
        window,
      )
    if (tests.size && rows.length > QUERY_LIMITS.candidates) exhausted("candidates")
    const evaluate = (node: ResolvedNode, row: Record<string, unknown>, text: string): boolean => {
      if (node.kind === "predicate") {
        const test = tests.get(node)
        return test ? test(text) : Number(row[`q${leaves.findIndex(([leaf]) => leaf === node)}`]) === 1
      }
      const must = node.clauses.filter(({ occur }) => occur === "must")
      const should = node.clauses.filter(({ occur }) => occur === "should")
      const not = node.clauses.filter(({ occur }) => occur === "must_not")
      return (
        (must.length
          ? must.every(({ node }) => evaluate(node, row, text))
          : should.length > 0 && should.some(({ node }) => evaluate(node, row, text))) &&
        not.every(({ node }) => !evaluate(node, row, text))
      )
    }
    const matched = tests.size
      ? rows.filter((row) => {
          check()
          const text = noteIndexText(row.title === null ? null : String(row.title), String(row.text))
          budget.work += text.length
          if (budget.work > QUERY_LIMITS.work) exhausted("detector work")
          return evaluate(query.root, row, text)
        })
      : rows
    return matched.map((row) => ({
      type: corpus.type,
      id: Number(row.id),
      at: row.at == null ? null : Number(row.at),
      relevance: row.relevance === null || row.relevance === undefined ? null : Number(row.relevance),
      ...(exactTier ? { exact: Number(row.exact) === 1 } : {}),
    }))
  })
}

export interface NoteChunkToEmbed {
  hash: string
  text: string
}

export interface NearestNote {
  ref: string
  note: Note
  /** Cosine of the note's best chunk; higher is nearer. */
  score: number
  /** The stretch of the indexed text (title, then text) that chunk holds. */
  range: { start: number; end: number }
}

export interface NoteSearch extends DocumentPictureStore {
  /** Indexes what was written since, then searches; a note written a moment ago is found. */
  search(query: NoteQuery): Promise<{ items: NoteHit[]; hasMore: boolean }>
  indexState(): Promise<NoteIndexState | undefined>
  /** Live notes' chunks with no vector of `model`, by hash from `after`, each with its text cut again. */
  chunksToEmbed(model: string, options: { after?: string; limit: number }): Promise<NoteChunkToEmbed[]>
  /** Whether any live chunk in this scope has a vector of `model`: none means meaning search has nothing to rank. */
  embedded(
    model: string,
    options: { folderIds?: string[]; withInternal?: boolean; source?: Note["source"] },
  ): Promise<boolean>
  /** Notes nearest in meaning to `query`, each scored by its best chunk. Vectors are unit length. */
  nearest(
    model: string,
    query: Float32Array,
    options: { limit: number; folderIds?: string[]; withInternal?: boolean; source?: Note["source"] },
  ): Promise<NearestNote[]>
}

const SCAN_PAGE = 5_000

/** A note's best chunk so far, and its lowest chunk, by which the scan breaks ties. */
interface Best {
  score: number
  first: number
  chunk: number
  start: number
  end: number
}

/** The live documents and notes of a chunk scan, narrowed by folder and source. */
const LIVE =
  "((k.chunkable_type = 'document' AND EXISTS (SELECT 1 FROM documents d WHERE d.id = k.chunkable_id AND d.deleted_at IS NULL AND coalesce(json_extract(d.metadata, '$.catalog.active'), 1)=1 " +
  "AND (? IS NULL OR d.account_id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))))) " +
  "OR (k.chunkable_type = 'note' AND ? IS NULL AND EXISTS (SELECT 1 FROM notes n WHERE n.id = k.chunkable_id AND n.deleted_at IS NULL)))"

export const noteSearchOver = (context: StoreContext): NoteSearch => {
  const { database } = context
  const stemmerFor = stemmerCache()
  const drain = () => drainNoteIndex(database, stemmerFor)
  const read = (type: string, id: number): Note | undefined => {
    const row = database.prepare(`SELECT * FROM ${type === "document" ? "documents" : "notes"} WHERE id = ?`).get(id)
    return row ? (type === "document" ? documentOf(row) : noteOf(row)) : undefined
  }
  const live = (folderIds: string[] | undefined, source: Note["source"] | undefined, withInternal = false) => {
    const folders = folderIds?.length ? JSON.stringify(folderIds) : null
    const types = source === undefined ? ["document", "note"] : source === "file" ? ["document"] : ["note"]
    return {
      sql: ` AND k.chunkable_type IN (${types.map(() => "?").join(", ")}) AND ${LIVE}`,
      params: [...types, folders, folders, withInternal ? null : folders] as SqlValue[],
    }
  }
  return {
    ...documentPicturesOver(context),
    search: async (query) => {
      drain()
      return searchNotes(context, query)
    },
    indexState: async () => noteIndexState(database),
    chunksToEmbed: async (model, { after, limit }) => {
      drain()
      const scope = live(undefined, undefined)
      // One long note fills a whole batch; build its text once, not once per chunk.
      const texts = new Map<string, string | undefined>()
      const textOf = (owner: string) => {
        if (!texts.has(owner)) {
          const [type, id] = owner.split(":")
          const note = read(String(type), Number(id))
          texts.set(owner, note ? noteIndexText(note.title, note.text) : undefined)
        }
        return texts.get(owner)
      }
      return database
        .prepare(
          `SELECT k.content_hash AS hash, min(k.chunkable_type || ':' || k.chunkable_id) AS owner, k.start_offset AS start, k.end_offset AS end
             FROM chunks k
            WHERE k.content_hash > ?${scope.sql}
              AND NOT EXISTS (SELECT 1 FROM embeddings v WHERE v.model = ? AND v.content_hash = k.content_hash)
            GROUP BY k.content_hash ORDER BY k.content_hash LIMIT ?`,
        )
        .all(after ?? "", ...scope.params, model, limit)
        .flatMap((row) => {
          const text = textOf(String(row.owner))
          return text === undefined
            ? []
            : [{ hash: String(row.hash), text: text.slice(Number(row.start), Number(row.end)) }]
        })
    },
    embedded: async (model, { folderIds, withInternal, source }) => {
      drain()
      const scope = live(folderIds, source, withInternal)
      return (
        database
          .prepare(
            `SELECT 1 FROM chunks k JOIN embeddings v ON v.model = ? AND v.content_hash = k.content_hash
              WHERE 1 = 1${scope.sql} LIMIT 1`,
          )
          .get(model, ...scope.params) !== undefined
      )
    },
    nearest: async (model, query, { limit, folderIds, withInternal, source }) => {
      drain()
      const scope = live(folderIds, source, withInternal)
      const columns = `k.id, k.chunkable_type AS type, k.chunkable_id AS owner, k.start_offset AS start,
        k.end_offset AS end, k.content_hash AS hash, v.vector
           FROM chunks k JOIN embeddings v ON v.model = ? AND v.content_hash = k.content_hash`
      const keep = (best: Map<string, Best>, row: Record<string, unknown>) => {
        const score = dot(query, row.vector as Uint8Array)
        const key = `${row.type}:${row.owner}`
        const held = best.get(key)
        if (!held || score > held.score)
          best.set(key, {
            score,
            first: held?.first ?? Number(row.id),
            chunk: Number(row.id),
            start: Number(row.start),
            end: Number(row.end),
          })
      }
      // The scan meets each note first at its lowest chunk, and keeps that order among equal scores.
      const ranked = (best: Map<string, Best>) =>
        [...best.entries()].sort(([, a], [, b]) => b.score - a.score || a.first - b.first).slice(0, limit)

      const indexed = (): [string, Best][] | undefined => {
        const types = source === undefined ? ["document", "note"] : source === "file" ? ["document"] : ["note"]
        const accounts = database.prepare(
          "SELECT DISTINCT coalesce(account_id, 0) AS account FROM chunks WHERE chunkable_type = ?",
        )
        const wanted = folderIds?.length ? new Set(folderIds.map(Number)) : undefined
        const candidates = database.prepare(
          `SELECT ${columns} WHERE k.id IN (SELECT value FROM json_each(?))${scope.sql} ORDER BY k.id`,
        )
        const first = database.prepare(
          `SELECT min(k.id) AS first FROM chunks k JOIN embeddings v ON v.model = ? AND v.content_hash = k.content_hash
            WHERE k.chunkable_type = ? AND k.chunkable_id = ?${scope.sql}`,
        )
        const merged = new Map<string, Best>()
        for (const type of types)
          for (const { account } of accounts.all(type)) {
            if (type === "document" && wanted && !wanted.has(Number(account))) continue
            const found = searchIndex(
              database,
              model,
              { kind: type, account: Number(account) },
              query,
              limit,
              (near) => {
                const hashes = new Map(near.map(({ id, hash }) => [id, hash]))
                const best = new Map<string, Best>()
                for (const row of candidates.all(model, JSON.stringify([...hashes.keys()]), ...scope.params))
                  if (hashes.get(Number(row.id)) === row.hash) keep(best, row)
                for (const [key, held] of best) {
                  const [kind, owner] = key.split(":")
                  held.first = Number(first.get(model, String(kind), Number(owner), ...scope.params)?.first)
                }
                const results = ranked(best)
                return { results, best: results.map(([, { chunk }]) => chunk) }
              },
            )
            if (!found) return undefined
            for (const [key, held] of found) merged.set(key, held)
          }
        return ranked(merged)
      }

      const scanned = (): [string, Best][] => {
        const page = database.prepare(`SELECT ${columns} WHERE k.id > ?${scope.sql} ORDER BY k.id LIMIT ?`)
        const best = new Map<string, Best>()
        let after = 0
        for (;;) {
          const rows = page.all(model, after, ...scope.params, SCAN_PAGE)
          for (const row of rows) keep(best, row)
          const last = rows.at(-1)
          if (!last || rows.length < SCAN_PAGE) break
          after = Number(last.id)
        }
        return ranked(best)
      }

      return (indexed() ?? scanned()).flatMap(([key, { score, start, end }]) => {
        const [type, id] = key.split(":")
        const note = read(String(type), Number(id))
        return note ? [{ ref: note.ref, note, score, range: { start, end } }] : []
      })
    },
  }
}
