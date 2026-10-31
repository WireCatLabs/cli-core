import { CliError } from "@wirecat/cli-base"
import type { Page } from "../../domain/models.js"
import { type Automaton, compileAutomaton, type MatchBudget } from "../../search/lucene/automaton.js"
import type { QueryExecution, ResolvedNode, ResolvedPredicate } from "../../search/lucene/resolved.js"
import { isStemmed } from "../../search/lucene/resolved.js"
import { exhausted, QUERY_LIMITS, searchError } from "../../search/lucene/types.js"
import type { SqlValue } from "../driver.js"
import { emailHitsByPk } from "./emails.js"
import { placeHits } from "./hit-places.js"
import {
  type Corpus,
  combine,
  FIELD_COMPILERS,
  type FieldScope,
  type Fragment,
  ftsMatch,
  type Leaf,
  SPEECH,
} from "./lucene-fields.js"
import type { StoreContext } from "./open.js"
import { hitsByPk } from "./search.js"
import { read } from "./transaction.js"
import { type TranscriptPart, transcriptItems, transcriptTerms } from "./transcript-query.js"
import type { ScoredHit } from "./words.js"

export { type Corpus, prefixOf } from "./lucene-fields.js"

const MESSAGES: Corpus = {
  rows: "messages",
  threads: "chats",
  words: "message_words",
  stems: "message_stems",
  vocab: "message_words_vocab",
  item: "message",
  thread: "chat",
}

// The same column names as messages and chats, so every rule reads mail as it reads messages. The text is the
// subject, a blank line, then the body, so `subject:` reads the subject back from it.
const MAIL: Corpus = {
  rows: `(SELECT id, account_id, email_thread_id AS chat_id, external_id, deleted_at, from_identity_id AS sender_identity_id,
    outgoing, read, flagged, coalesce(sent_at, received_at) AS sent_at,
    coalesce(subject, '') || char(10, 10) || coalesce(body_text, '') AS text FROM emails)`,
  threads: "(SELECT id, account_id, external_id, subject AS title, 1 AS searchable FROM email_threads)",
  words: "email_words",
  stems: "email_stems",
  vocab: "email_words_vocab",
  item: "email",
  thread: "email_thread",
}

export type QueryGrouping = "chat" | "sender" | "time"
export interface QueryGroup {
  provider?: string
  account?: string
  id: string | null
  name: string | null
  outgoing?: boolean
  count: number
}
const GROUPS: Record<QueryGrouping, { key: string; select: string }> = {
  chat: {
    key: "m.chat_id",
    select: "ac.provider AS provider, ac.external_id AS account, c.external_id AS id, c.title AS name",
  },
  sender: {
    key: "coalesce(m.sender_identity_id, -m.account_id)",
    select:
      "ac.provider AS provider, ac.external_id AS account, i.external_id AS id, i.name AS name, max(m.outgoing) AS outgoing",
  },
  // Quarter hours, so a calendar day or hour in any zone (+05:30, +05:45) is a whole number of buckets.
  time: { key: "m.sent_at / 900000", select: "CAST(min(m.sent_at / 900000) * 900000 AS TEXT) AS id, NULL AS name" },
}
export const matchQuery = (context: StoreContext, execution: QueryExecution): Promise<Page<ScoredHit>> =>
  runQuery(context, execution) as Promise<Page<ScoredHit>>
/** Every match counted once, grouped; the work and candidate budgets of a search still apply. */
export const countQuery = (
  context: StoreContext,
  execution: QueryExecution,
  by: QueryGrouping,
): Promise<QueryGroup[]> => runQuery(context, execution, by) as Promise<QueryGroup[]>
/** All matching message keys, without materializing message bodies or imposing a hit-page limit. */
export const queryMessagePks = (context: StoreContext, execution: QueryExecution): Promise<number[]> =>
  runQuery(context, execution, "pks") as Promise<number[]>
/** How many messages match, counting no further than `cap + 1`; `undefined` as `matchingPks` says. */
export const countMatches = (context: StoreContext, execution: QueryExecution, cap: number): number | undefined =>
  matchingPks(context, execution, cap)?.length

/**
 * The keys of the messages that match, no more than `cap + 1`: one SQL query, unranked. `undefined` when a leaf is
 * checked row by row (a preset, a pattern), where it would cost as much as the search itself.
 */
export const matchingPks = (context: StoreContext, execution: QueryExecution, cap: number): number[] | undefined => {
  const { database, check, where, from, withRanking, ranked, leaves } = compileQuery(context, {
    ...execution,
    newest: true,
  })
  if (leaves.some(({ test }) => test)) return undefined
  const rows = database
    .prepare(`${withRanking}SELECT m.id ${from} WHERE ${where.sql} LIMIT ?`)
    .all(...ranked.params, ...where.params, cap + 1)
  check()
  return rows.map(({ id }) => Number(id))
}
const compileQuery = (context: StoreContext, execution: QueryExecution, boundedAttachments = false) => {
  const { database } = context
  const corpus = execution.corpus === "mail" ? MAIL : MESSAGES
  const mail = corpus === MAIL
  if (mail && (execution.only || execution.conversationIds || execution.conversationSince !== undefined))
    throw new CliError("validation_error", "mail has no server search or conversations")
  const started = context.now()
  const budget: MatchBudget = { work: 0 }
  let states = 0,
    expansions = 0
  const patterns = new Map<string, Automaton>()
  const expanded = new Map<string, Fragment>()
  const check = () => {
    if (execution.signal?.aborted)
      throw new CliError("validation_error", "search was aborted", { reason: "query.aborted", complete: false })
    if (context.now() - started > QUERY_LIMITS.milliseconds) exhausted("time")
  }
  const patternOf = (pattern: string, node: ResolvedPredicate) => {
    check()
    const known = patterns.get(pattern)
    if (known) return known
    const automaton = compileAutomaton(pattern, node.span)
    states += automaton.states
    if (states > QUERY_LIMITS.states) exhausted("automaton states")
    patterns.set(pattern, automaton)
    return automaton
  }
  const fragments = new Map<ResolvedPredicate, Leaf>()
  const namedSql = `SELECT att.attachable_id FROM attachments att WHERE att.attachable_type='${corpus.item}' AND att.id IN (SELECT rowid FROM attachment_name_words WHERE attachment_name_words MATCH ?)`
  const attachmentWords = (match: string, which: "file" | "transcript" | "any") => ({
    sql: `SELECT att.attachable_id FROM attachments att WHERE att.attachable_type='${corpus.item}'${which === "any" ? "" : ` AND ${which === "file" ? "NOT " : ""}${SPEECH}`} AND att.id IN (SELECT rowid FROM attachment_words WHERE attachment_words MATCH ?)`,
    params: [match] as SqlValue[],
  })
  const transcripts = transcriptTerms(database, execution.root, corpus.item)
  const said = (node: ResolvedPredicate, part?: TranscriptPart) =>
    transcriptItems(
      corpus.item,
      transcripts.get(node) ?? { match: ftsMatch(node), widened: [], from: node.value },
      part,
    )
  /** A bare word also matches a transcript, a file's text and a word of a file's name. */
  const everywhere = (node: ResolvedPredicate, fragment: Fragment): Fragment => {
    if (!node.implicit || fragment.sql === "0") return fragment
    const match = ftsMatch(node)
    const files = attachmentWords(match, "file")
    const spoken = said(node)
    const elsewhere = {
      sql: `${files.sql} UNION ${spoken.sql} UNION ${namedSql}`,
      params: [...files.params, ...spoken.params, match],
    }
    return {
      ...fragment,
      sql: `(${fragment.sql} OR m.id IN (${elsewhere.sql}))`,
      params: [...fragment.params, ...elsewhere.params],
      elsewhere,
    }
  }
  const fields: FieldScope = {
    database,
    execution,
    corpus,
    mail,
    boundedAttachments,
    budget,
    check,
    patternOf,
    expanded,
    attachmentWords,
    transcripts: (node) => said(node),
    everywhere,
    expand: (count) => {
      expansions += count
      return expansions
    },
  }
  const createLeaf = (node: ResolvedPredicate): Leaf => {
    const compiler = FIELD_COMPILERS[node.field]
    if (!compiler) return searchError("query.unsupported-field", node.span)
    const compiled = compiler(node, fields)
    if ("node" in compiled) return compiled
    const { fragment, test } = compiled
    return { node, fragment: { ...fragment, sql: `(${fragment.sql})` }, ...(test ? { test } : {}) }
  }
  const compile = (node: ResolvedNode): Fragment => {
    if (node.kind === "predicate") {
      const leaf = createLeaf(node)
      fragments.set(node, leaf)
      return leaf.fragment
    }
    const clauses = node.clauses.map(({ occur, node }) => ({ occur, part: compile(node) }))
    const required = clauses.filter(({ occur }) => occur === "must")
    const optional = clauses.filter(({ occur }) => occur === "should")
    const prohibited = clauses.filter(({ occur }) => occur === "must_not")
    const positive = required.length
      ? combine(
          required.map(({ part }) => part),
          "AND",
        )
      : combine(
          optional.map(({ part }) => part),
          "OR",
        )
    const negatives = prohibited.map(({ part }) =>
      part.exact ? { ...part, sql: `NOT coalesce(${part.sql},0)` } : { sql: "1", params: [], exact: false },
    )
    const result = combine([positive, ...negatives], "AND")
    return { ...result, exact: clauses.every(({ part }) => part.exact) }
  }
  check()
  if (execution.accounts.length === 0) searchError("query.invalid-scope", { start: 0, end: 0 })
  const expression = compile(execution.root)
  const scopeParts = execution.accounts.map(({ provider, account }) => ({
    sql: "ac.provider=? AND ac.external_id=?",
    params: [provider, account],
    exact: true,
  }))
  let scope = combine(scopeParts, "OR")
  if (execution.chat)
    scope = combine(
      [
        scope,
        {
          sql: "ac.provider=? AND ac.external_id=? AND c.external_id=?",
          params: [execution.chat.account.provider, execution.chat.account.account, execution.chat.chatId],
          exact: true,
        },
      ],
      "AND",
    )
  else scope = combine([scope, { sql: "c.searchable=1", params: [], exact: true }], "AND")
  if (execution.senders)
    scope = combine(
      [
        scope,
        combine(
          execution.senders.map(({ provider, id }) => ({
            sql: "i.provider=? AND i.external_id=?",
            params: [provider, id],
            exact: true,
          })),
          "OR",
        ),
      ],
      "AND",
    )
  let where = combine([{ sql: "m.deleted_at IS NULL", params: [], exact: true }, scope, expression], "AND")
  if (execution.conversationIds !== undefined || execution.conversationSince !== undefined) {
    const ids = execution.conversationIds
    where = combine(
      [
        where,
        {
          sql: `m.id IN (SELECT cm.message_id FROM conversation_messages cm JOIN conversations cv ON cv.id=cm.conversation_id JOIN conversation_state cs ON cs.chat_id=cv.chat_id AND cs.current_build=cv.build WHERE 1${ids === undefined ? "" : " AND cv.id IN (SELECT value FROM json_each(?))"}${execution.conversationSince === undefined ? "" : " AND cv.last_at>=?"})`,
          params: [
            ...(ids === undefined ? [] : [JSON.stringify(ids)]),
            ...(execution.conversationSince === undefined ? [] : [execution.conversationSince]),
          ],
          exact: true,
        },
      ],
      "AND",
    )
  }
  if (execution.only)
    where = combine(
      [
        where,
        {
          sql: `m.id IN (SELECT picked.id FROM json_each(?) j CROSS JOIN accounts allowed CROSS JOIN chats scoped CROSS JOIN messages picked
            WHERE (${execution.accounts.map(() => "(allowed.provider=? AND allowed.external_id=?)").join(" OR ") || "0"})
              AND allowed.provider=json_extract(j.value,'$.provider') AND allowed.external_id=json_extract(j.value,'$.account')
              AND scoped.account_id=allowed.id AND scoped.external_id=json_extract(j.value,'$.chatId')
              AND picked.chat_id=scoped.id AND picked.external_id=json_extract(j.value,'$.id'))`,
          params: [JSON.stringify(execution.only), ...execution.accounts.flatMap((key) => [key.provider, key.account])],
          exact: true,
        },
      ],
      "AND",
    )
  const rowsFrom = `FROM ${corpus.rows} m`
  const joinedFrom = `${rowsFrom} JOIN ${corpus.threads} c ON c.id=m.chat_id JOIN accounts ac ON ac.id=m.account_id LEFT JOIN identities i ON i.id=m.sender_identity_id`
  let baseFrom = joinedFrom
  const requiredText = (node: ResolvedNode, index: "fts" | "stems" = "fts"): string | undefined => {
    if (node.kind === "predicate") return fragments.get(node)?.fragment[index]
    const required = node.clauses.filter(({ occur }) => occur === "must")
    const optional = node.clauses.filter(({ occur }) => occur === "should")
    if (required.length) {
      const parts = required.flatMap(({ node }) => requiredText(node, index) ?? [])
      return parts.length ? parts.map((part) => `(${part})`).join(" AND ") : undefined
    }
    const parts = optional.map(({ node }) => requiredText(node, index))
    return parts.length && parts.every((part) => part !== undefined)
      ? parts.map((part) => `(${part})`).join(" OR ")
      : undefined
  }
  const stemmed = [...fragments.keys()].some(isStemmed)
  // A word found only in a file is not in the word index, so neither may filter: they rank, joined LEFT.
  const elsewhere = [...fragments.values()].some(({ fragment }) => fragment.elsewhere)
  const rankMatch = stemmed || elsewhere ? undefined : requiredText(execution.root)
  if (execution.chat && !rankMatch && !stemmed && !elsewhere) {
    baseFrom = `FROM ${corpus.threads} c JOIN accounts ac ON ac.id=c.account_id CROSS JOIN ${corpus.rows} m LEFT JOIN identities i ON i.id=m.sender_identity_id`
    where = combine([{ sql: "m.chat_id=c.id", params: [], exact: true }, where], "AND")
  }
  // A stemmed search starts from the messages its indexes name, read by key; without it SQLite walks every
  // message of the account and tests each against the index sets.
  const driverOf = (node: ResolvedNode): { sql: string; params: SqlValue[] } | undefined => {
    if (node.kind === "predicate") {
      const { fts, stems, elsewhere: other } = fragments.get(node)?.fragment ?? {}
      if (fts === undefined) return undefined
      const words = `SELECT rowid AS id FROM ${corpus.words} WHERE ${corpus.words} MATCH ?`
      const own =
        isStemmed(node) && stems
          ? {
              sql: `${words} UNION SELECT rowid FROM ${corpus.stems} WHERE ${corpus.stems} MATCH ?`,
              params: [`normalized_text : (${fts})`, `stems : (${stems})`] as SqlValue[],
            }
          : { sql: words, params: [`normalized_text : (${fts})`] as SqlValue[] }
      return other ? { sql: `${own.sql} UNION ${other.sql}`, params: [...own.params, ...other.params] } : own
    }
    const required = node.clauses.filter(({ occur }) => occur === "must")
    const optional = node.clauses.filter(({ occur }) => occur === "should")
    const parts = required.length
      ? required.flatMap(({ node }) => driverOf(node) ?? [])
      : optional.map(({ node }) => driverOf(node))
    if (!parts.length || parts.some((part) => part === undefined)) return undefined
    const sets = parts as { sql: string; params: SqlValue[] }[]
    return {
      sql: sets.map(({ sql }) => `SELECT id FROM (${sql})`).join(required.length ? " INTERSECT " : " UNION "),
      params: sets.flatMap(({ params }) => params),
    }
  }
  const driver = stemmed || elsewhere ? driverOf(execution.root) : undefined
  const filtered = where
  if (driver) where = combine([{ sql: "m.id=d.id", params: [], exact: true }, where], "AND")
  const from = rankMatch
    ? baseFrom.replace(rowsFrom, `FROM ${corpus.words} f CROSS JOIN ${corpus.rows} m`)
    : driver
      ? baseFrom.replace(rowsFrom, `FROM d CROSS JOIN ${corpus.rows} m`)
      : baseFrom
  if (rankMatch)
    where = combine(
      [
        {
          sql: `${corpus.words} MATCH ? AND f.rank MATCH 'bm25(1.0, 0.0)' AND m.id=f.rowid`,
          params: [`normalized_text : (${rankMatch})`],
          exact: true,
        },
        where,
      ],
      "AND",
    )
  // A stemmed search ranks by stems but must not filter by them, so its ranking is a set computed once and
  // joined LEFT; joined row by row, the same query took 420 ms instead of 5 at 100k (stemming gate).
  const ranking = stemmed ? requiredText(execution.root, "stems") : elsewhere ? requiredText(execution.root) : undefined
  const rankIndex = stemmed
    ? { table: corpus.stems, column: "stems" }
    : { table: corpus.words, column: "normalized_text" }
  const exactTier = stemmed ? requiredText(execution.root) : undefined
  const ranked: { sql: string[]; params: SqlValue[] } = driver
    ? { sql: [`d(id) AS MATERIALIZED (${driver.sql})`], params: [...driver.params] }
    : { sql: [], params: [] }
  if (ranking && !execution.newest) {
    ranked.sql.push(
      `f(id, rank) AS MATERIALIZED (SELECT rowid, bm25(${rankIndex.table}, 1.0, 0.0) FROM ${rankIndex.table} WHERE ${rankIndex.table} MATCH ?)`,
    )
    ranked.params.push(`${rankIndex.column} : (${ranking})`)
  }
  // Among hits the message text does not hold: a transcript as typed, in another form, then a file's name, a file's
  // text, and last a garbled spelling. bm25 scores of different indexes do not compare, and a long spreadsheet must
  // not crowd out what was said.
  const placeNodes = [...fragments.values()].flatMap(({ node, fragment }) =>
    fragment.elsewhere && fragment.fts ? [node] : [],
  )
  const places = placeNodes.map(ftsMatch)
  if (places.length && !execution.newest) {
    const spoken = (part: TranscriptPart, tier: number) =>
      placeNodes.map((node) => {
        const one = said(node, part)
        return { sql: `SELECT attachable_id, ${tier} FROM (${one.sql})`, params: one.params }
      })
    const parts = [...spoken("forms", 2), ...spoken("widened", 5)]
    ranked.sql.push(
      `s(id, tier) AS MATERIALIZED (SELECT att.attachable_id, min(CASE WHEN ${SPEECH} THEN 1 ELSE 4 END) FROM attachments att WHERE att.attachable_type='${corpus.item}' AND att.id IN (SELECT rowid FROM attachment_words WHERE attachment_words MATCH ?) GROUP BY att.attachable_id UNION ALL SELECT attachable_id, 3 FROM (${namedSql})${parts.map(({ sql }) => ` UNION ALL ${sql}`).join("")})`,
    )
    ranked.params.push(places.join(" OR "), places.join(" OR "), ...parts.flatMap(({ params }) => params))
  }
  const placeTier = places.length && !execution.newest ? "coalesce((SELECT min(tier) FROM s WHERE s.id=m.id), 6)," : ""
  if (exactTier) {
    ranked.sql.push(`x(id) AS MATERIALIZED (SELECT rowid FROM ${corpus.words} WHERE ${corpus.words} MATCH ?)`)
    ranked.params.push(`normalized_text : (${exactTier})`)
  }
  const withRanking = ranked.sql.length ? `WITH ${ranked.sql.join(", ")} ` : ""
  const rankedFrom = ranking && !execution.newest ? `${from} LEFT JOIN f ON f.id=m.id` : from
  const exactColumn = exactTier ? ", m.id IN (SELECT id FROM x) AS exact" : ""
  const relevance = rankMatch ? "f.rank" : ranking && !execution.newest ? "f.rank" : "NULL"
  const tiers = execution.newest
    ? ""
    : rankMatch
      ? "f.rank,"
      : `${exactTier ? "exact DESC," : ""}${ranking ? `f.rank IS NULL, ${placeTier}f.rank,` : placeTier}`
  const order = `${tiers}m.sent_at DESC, ac.provider, ac.external_id, c.external_id, m.external_id DESC`
  const leaves = [...fragments.values()]
  const exact = leaves.filter(({ test }) => test === undefined)
  const projection = exact.map(({ fragment }, index) => `coalesce(${fragment.sql},0) AS q${index}`).join(",")
  const projectionParams = exact.flatMap(({ fragment }) => fragment.params)
  const evaluate = (node: ResolvedNode, row: Record<string, unknown>, text: string, attachments: string[]): boolean => {
    if (node.kind === "predicate") {
      const leaf = fragments.get(node) as Leaf
      return leaf.test ? leaf.test(text, attachments) : Number(row[`q${exact.indexOf(leaf)}`]) === 1
    }
    const must = node.clauses.filter(({ occur }) => occur === "must")
    const should = node.clauses.filter(({ occur }) => occur === "should")
    const not = node.clauses.filter(({ occur }) => occur === "must_not")
    return (
      (must.length
        ? must.every(({ node }) => evaluate(node, row, text, attachments))
        : should.length > 0 && should.some(({ node }) => evaluate(node, row, text, attachments))) &&
      not.every(({ node }) => !evaluate(node, row, text, attachments))
    )
  }
  const grouped = (by: QueryGrouping, sql: string, params: SqlValue[], source: string, prefix = ""): QueryGroup[] => {
    const group = GROUPS[by]
    return database
      .prepare(`${prefix}SELECT ${group.select}, count(*) AS count ${source} WHERE ${sql} GROUP BY ${group.key}`)
      .all(...params)
      .map((row) => ({
        ...(row.provider == null ? {} : { provider: String(row.provider), account: String(row.account) }),
        id: row.id == null ? null : String(row.id),
        name: row.name == null ? null : String(row.name),
        ...(row.outgoing == null ? {} : { outgoing: Number(row.outgoing) === 1 }),
        count: Number(row.count),
      }))
  }
  const placed = (found: ReturnType<typeof hitsByPk>, pks: number[]) =>
    placeHits(database, corpus, [...fragments.values()], transcripts, found, pks)
  const hits = (pks: number[]) =>
    placed(mail ? emailHitsByPk(database, pks) : hitsByPk(context, pks), pks) as ReturnType<typeof hitsByPk>
  return {
    corpus,
    rowsFrom,
    hits,
    database,
    check,
    grouped,
    where,
    from,
    withRanking,
    ranked,
    leaves,
    stemmed,
    exactTier,
    driver,
    baseFrom,
    filtered,
    ranking,
    relevance,
    rankedFrom,
    exactColumn,
    order,
    placeTier,
    projection,
    projectionParams,
    joinedFrom,
    evaluate,
  }
}

interface QuerySelection {
  sql: string
  params: SqlValue[]
}

/** The matcher and its consumer run synchronously in one read snapshot; exact keys stay in SQL. */
export const withQuerySelection = <T>(
  context: StoreContext,
  execution: QueryExecution,
  consume: (selection: QuerySelection, check: () => void) => T,
): T => {
  const { database } = context
  return read(database, () => {
    const query = compileQuery(context, execution, true)
    const { check, leaves, where, from, withRanking, ranked } = query
    check()
    let selection: QuerySelection
    if (leaves.every(({ test }) => !test)) {
      selection = {
        sql: `${withRanking}SELECT DISTINCT m.id AS id ${from} WHERE ${where.sql}`,
        params: [...ranked.params, ...where.params],
      }
    } else {
      const candidates = database
        .prepare(
          `${withRanking}SELECT m.id AS id, length(cast(m.text AS BLOB)) AS bytes ${from} WHERE ${where.sql} ORDER BY m.id LIMIT ?`,
        )
        .all(...ranked.params, ...where.params, QUERY_LIMITS.candidates + 1)
      check()
      if (candidates.length > QUERY_LIMITS.candidates) exhausted("candidate rows")
      if (candidates.reduce((sum, row) => sum + Number(row.bytes), 0) > QUERY_LIMITS.bodyBytes) exhausted("body bytes")
      const matched: number[] = []
      for (let offset = 0; offset < candidates.length; offset += 500) {
        check()
        const pks = candidates.slice(offset, offset + 500).map(({ id }) => Number(id))
        const rows = database
          .prepare(
            `SELECT m.id AS id, m.text AS body${query.projection ? `,${query.projection}` : ""},(SELECT json_group_array(att.kind) FROM attachments att WHERE att.attachable_type='${query.corpus.item}' AND att.attachable_id=m.id) AS attachment_kinds ${query.joinedFrom} WHERE m.id IN (${pks.map(() => "?").join(",")})`,
          )
          .all(...query.projectionParams, ...pks)
        for (const row of rows) {
          check()
          const attachments: unknown = JSON.parse(String(row.attachment_kinds))
          if (
            query.evaluate(
              execution.root,
              row,
              String(row.body),
              Array.isArray(attachments) ? attachments.map(String) : [],
            )
          )
            matched.push(Number(row.id))
        }
      }
      selection = { sql: "SELECT value AS id FROM json_each(?)", params: [JSON.stringify(matched)] }
    }
    const result = consume(selection, check)
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      "then" in result &&
      typeof result.then === "function"
    )
      throw new Error("query selection consumers must run synchronously")
    check()
    return result
  })
}

const runQuery = async (
  context: StoreContext,
  execution: QueryExecution,
  by?: QueryGrouping | "pks",
): Promise<Page<ScoredHit> | QueryGroup[] | number[]> => {
  const {
    corpus,
    rowsFrom,
    hits,
    database,
    check,
    grouped,
    where,
    from,
    withRanking,
    ranked,
    leaves,
    stemmed,
    exactTier,
    driver,
    baseFrom,
    filtered,
    ranking,
    relevance,
    rankedFrom,
    exactColumn,
    order,
    placeTier,
    projection,
    projectionParams,
    joinedFrom,
    evaluate,
  } = compileQuery(context, execution)
  if (by === "pks" && leaves.every(({ test }) => !test)) {
    const rows = database
      .prepare(`${withRanking}SELECT m.id AS id ${from} WHERE ${where.sql}`)
      .all(...ranked.params, ...where.params)
    await new Promise<void>((resolve) => setImmediate(resolve))
    check()
    return rows.map(({ id }) => Number(id))
  }
  if (by && by !== "pks" && leaves.every(({ test }) => !test))
    return grouped(by, where.sql, [...ranked.params, ...where.params], from, withRanking)
  // Exact forms come first, so a page they fill needs neither the stems nor their bm25: for a word in a few
  // percent of messages that was most of the cost (PERF-9). The exact tier is ranked as exact search ranks it.
  if (stemmed && exactTier && driver && !execution.newest && leaves.every(({ test }) => !test)) {
    const exactRows = database
      .prepare(
        `SELECT m.id AS id, w.rank AS relevance ${baseFrom.replace(rowsFrom, `FROM ${corpus.words} w CROSS JOIN ${corpus.rows} m`)} WHERE ${corpus.words} MATCH ? AND w.rank MATCH 'bm25(1.0, 0.0)' AND m.id=w.rowid AND ${filtered.sql} ORDER BY w.rank, m.sent_at DESC, ac.provider, ac.external_id, c.external_id, m.external_id DESC LIMIT ?`,
      )
      .all(`normalized_text : (${exactTier})`, ...filtered.params, execution.limit + 1)
    await new Promise<void>((resolve) => setImmediate(resolve))
    check()
    const room = execution.limit + 1 - exactRows.length
    const otherRows =
      room > 0
        ? database
            .prepare(
              `${withRanking}SELECT m.id AS id, ${relevance} AS relevance ${rankedFrom} WHERE ${where.sql} AND m.id NOT IN (SELECT id FROM x) ORDER BY ${ranking ? `f.rank IS NULL, ${placeTier}f.rank,` : placeTier}m.sent_at DESC, ac.provider, ac.external_id, c.external_id, m.external_id DESC LIMIT ?`,
            )
            .all(...ranked.params, ...where.params, room)
        : []
    await new Promise<void>((resolve) => setImmediate(resolve))
    check()
    const rows = [
      ...exactRows.map(({ id, relevance }) => ({ id, relevance, exact: true })),
      ...otherRows.map(({ id, relevance }) => ({ id, relevance, exact: false })),
    ]
    return {
      items: hits(rows.slice(0, execution.limit).map(({ id }) => Number(id))).map((hit, index) => ({
        ...hit,
        score: rows[index]?.relevance == null ? null : -Number(rows[index]?.relevance),
        exact: rows[index]?.exact === true,
      })),
      hasMore: rows.length > execution.limit,
    }
  }
  if (leaves.every(({ test }) => !test)) {
    const rows = database
      .prepare(
        `${withRanking}SELECT m.id AS id, ${relevance} AS relevance${exactColumn} ${rankedFrom} WHERE ${where.sql} ORDER BY ${order} LIMIT ?`,
      )
      .all(...ranked.params, ...where.params, execution.limit + 1)
    await new Promise<void>((resolve) => setImmediate(resolve))
    check()
    return {
      items: hits(rows.slice(0, execution.limit).map(({ id }) => Number(id))).map((hit, index) => ({
        ...hit,
        score: rows[index]?.relevance == null ? null : -Number(rows[index]?.relevance),
        ...(exactColumn ? { exact: Number(rows[index]?.exact) === 1 } : {}),
      })),
      hasMore: rows.length > execution.limit,
    }
  }
  const candidates = database
    .prepare(
      `${withRanking}SELECT m.id AS id, ${relevance} AS relevance${exactColumn}, length(cast(m.text AS BLOB)) AS bytes ${rankedFrom} WHERE ${where.sql} ORDER BY ${order} LIMIT ?`,
    )
    .all(...ranked.params, ...where.params, QUERY_LIMITS.candidates + 1)
  await new Promise<void>((resolve) => setImmediate(resolve))
  check()
  if (candidates.length > QUERY_LIMITS.candidates) exhausted("candidate rows")
  if (candidates.reduce((sum, row) => sum + Number(row.bytes), 0) > QUERY_LIMITS.bodyBytes) exhausted("body bytes")
  const found: number[] = []
  const scores = new Map(
    candidates.map((row) => [Number(row.id), row.relevance == null ? null : -Number(row.relevance)]),
  )
  const exactness = new Map(candidates.map((row) => [Number(row.id), Number(row.exact) === 1]))
  for (let offset = 0; offset < candidates.length; offset += 500) {
    if (offset > 0) await new Promise<void>((resolve) => setImmediate(resolve))
    check()
    const pks = candidates.slice(offset, offset + 500).map(({ id }) => Number(id))
    const rows = database
      .prepare(
        `SELECT m.id AS id,m.text AS body${projection ? `,${projection}` : ""},(SELECT json_group_array(att.kind) FROM attachments att WHERE att.attachable_type='${corpus.item}' AND att.attachable_id=m.id) AS attachment_kinds ${joinedFrom} WHERE m.id IN (${pks.map(() => "?").join(",")})`,
      )
      .all(...projectionParams, ...pks)
    const byPk = new Map(rows.map((row) => [Number(row.id), row]))
    for (const id of pks) {
      check()
      const row = byPk.get(id) as Record<string, unknown>
      const attachments: unknown = JSON.parse(String(row.attachment_kinds))
      if (evaluate(execution.root, row, String(row.body), Array.isArray(attachments) ? attachments.map(String) : []))
        found.push(id)
      if (!by && found.length > execution.limit) break
    }
    if (!by && found.length > execution.limit) break
  }
  if (by === "pks") return found
  if (by) return grouped(by, "m.id IN (SELECT value FROM json_each(?))", [JSON.stringify(found)], joinedFrom)
  return {
    items: hits(found.slice(0, execution.limit)).map((hit, index) => ({
      ...hit,
      score: scores.get(found[index] as number) ?? null,
      ...(exactColumn ? { exact: exactness.get(found[index] as number) === true } : {}),
    })),
    hasMore: found.length > execution.limit,
  }
}
