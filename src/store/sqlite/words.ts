import type { ScoredHit, SearchScope, WordOptions, WordQuery } from "../contracts/words-types.js"

export type { MatchPlace, ScoredHit, SearchScope, WordOptions, WordQuery } from "../contracts/words-types.js"

import { CliError } from "@wirecat/cli-base"
import { storedKinds } from "../../domain/attachments.js"
import type { Page } from "../../domain/models.js"
import type { Term } from "../../search/query.js"
import type { SqlValue } from "../driver.js"
import { normalize } from "../normalize.js"
import { findAccountPk } from "./accounts.js"
import { findChatPk } from "./chats.js"
import type { StoreContext } from "./open.js"
import { hitsByPk } from "./search.js"

/**
 * A chat or a sender with at most this many messages is filtered inside the word index; a larger one by
 * a join (phase 2 plan S6). Measured on 1M (`bench/search/store-chain.ts`): the token is 3.5 times
 * faster for "any word" in an 85k chat, and 5% slower in a 500k one.
 */
export const SCOPE_TOKEN_LIMIT = 100_000
/** The scope column out of bm25: otherwise a chat under the limit would rank its hits by the token too. */
const UNSCOPED_RANK = "bm25(1.0, 0.0)"
/** Ranked inside the index first, this many times the page, before the join drops other accounts' rows. */
const RANKED_FIRST = 5

interface Resolved {
  accountPks: number[]
  chatPk?: number
  chatMessages?: number
  senderPk?: number
  senderMessages?: number
  senderPks?: number[]
}

const quoted = (text: string) => `"${text.replaceAll('"', '""')}"`
const meaningful = (text: string) => /[\p{L}\p{N}]/u.test(text)
const textOf = (term: Term) => normalize(term.kind === "phrase" ? term.words.join(" ") : term.text)

const wordTerm = (term: Term, beginnings: boolean): string | undefined => {
  const text = textOf(term)
  if (!meaningful(text)) return undefined
  return beginnings && term.kind === "word" && [...text].length >= 3 ? `${quoted(text)}*` : quoted(text)
}

/** Null when nothing in the scope can match: an unknown account, chat or sender. */
const resolve = (context: StoreContext, scope: SearchScope): Resolved | null => {
  if (scope.accounts.length === 0) throw new CliError("validation_error", "a search names at least one account")
  const accountPks = scope.accounts.flatMap((key) => findAccountPk(context, key) ?? [])
  if (accountPks.length === 0) return null
  const resolved: Resolved = { accountPks }
  const { database } = context
  if (scope.chat) {
    const account = findAccountPk(context, scope.chat.account)
    const chatPk = account === undefined ? undefined : findChatPk(context, account, scope.chat.chatId)
    if (chatPk === undefined) return null
    resolved.chatPk = chatPk
    resolved.chatMessages = Number(
      database.prepare("SELECT message_count FROM chats WHERE id = ?").get(chatPk)?.message_count,
    )
  }
  if (scope.senders) {
    const lookup = database.prepare("SELECT id AS pk FROM identities WHERE provider = ? AND external_id = ?")
    resolved.senderPks = scope.senders.flatMap(({ provider, id }) => {
      const pk = lookup.get(provider, id)?.pk
      return pk === undefined ? [] : [Number(pk)]
    })
    if (resolved.senderPks.length === 0) return null
  }
  if (scope.sender) {
    const senderPk = database
      .prepare("SELECT id AS pk FROM identities WHERE provider = ? AND external_id = ?")
      .get(scope.sender.provider, scope.sender.id)?.pk
    if (senderPk === undefined) return null
    resolved.senderPk = Number(senderPk)
    // Counted only as far as the limit: past it the answer is "large", whatever the number.
    resolved.senderMessages = Number(
      database
        .prepare("SELECT count(*) AS n FROM (SELECT 1 FROM messages WHERE sender_identity_id = ? LIMIT ?)")
        .get(resolved.senderPk, SCOPE_TOKEN_LIMIT + 1)?.n,
    )
  }
  return resolved
}

/** The conditions on the message row, shared by every step. */
const rowConditions = (resolved: Resolved, scope: SearchScope, joined: { chat: boolean; sender: boolean }) => {
  const where = ["m.deleted_at IS NULL", `m.account_id IN (${resolved.accountPks.join(", ")})`]
  const params: SqlValue[] = []
  if (joined.chat) {
    where.push("m.chat_id = ?")
    params.push(resolved.chatPk as number)
  }
  if (joined.sender) {
    where.push("m.sender_identity_id = ?")
    params.push(resolved.senderPk as number)
  }
  if (resolved.senderPks) where.push(`m.sender_identity_id IN (${resolved.senderPks.join(", ")})`)
  if (scope.outgoing) where.push("m.outgoing = 1")
  if (scope.after !== undefined) {
    where.push("m.sent_at >= ?")
    params.push(scope.after)
  }
  if (scope.before !== undefined) {
    where.push("m.sent_at < ?")
    params.push(scope.before)
  }
  for (const kind of scope.has ?? []) {
    if (kind === "link") where.push(`m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH '"://"')`)
    else if (kind === "attachment")
      where.push("EXISTS (SELECT 1 FROM attachments a WHERE a.attachable_type = 'message' AND a.attachable_id = m.id)")
    else {
      const kinds = storedKinds(kind)
      where.push(
        `EXISTS (SELECT 1 FROM attachments a WHERE a.attachable_type = 'message' AND a.attachable_id = m.id AND a.kind IN (${kinds.map(() => "?").join(",")}))`,
      )
      params.push(...kinds)
    }
  }
  // A chat marked not searchable is searched only when the search names it (plan S9).
  if (!scope.chat) where.push("c.searchable = 1")
  return { where: where.join(" AND "), params }
}

const page = (context: StoreContext, rows: { pk: number; score: number | null }[], limit: number): Page<ScoredHit> => {
  const kept = rows.slice(0, limit)
  const scores = new Map(kept.map((row) => [row.pk, row.score]))
  const hits = hitsByPk(
    context,
    kept.map((row) => row.pk),
  )
  return {
    items: hits.map((hit, index) => {
      const score = scores.get((kept[index] as { pk: number }).pk) ?? null
      return { ...hit, score: score === null ? null : -score }
    }),
    hasMore: rows.length > limit,
  }
}

/**
 * Steps 1, 2 and 4 of the search (plan S4): the word index, ranked by bm25, ties newest first. A small
 * chat or sender is a token inside the index, a large one a join; with neither, the index ranks first
 * and the join keeps this account's rows (plan S6). The index is always searched before the rows.
 */
export const matchWords = (
  context: StoreContext,
  query: WordQuery,
  scope: SearchScope,
  { mode, beginnings, limit, newest = false }: WordOptions,
): Page<ScoredHit> => {
  const empty = { items: [], hasMore: false }
  const groups = query.required
    .map((group) => group.flatMap((term) => wordTerm(term, beginnings) ?? []))
    .filter((group) => group.length > 0)
  if (groups.length === 0) return empty
  const resolved = resolve(context, scope)
  if (!resolved) return empty

  const tokenChat = resolved.chatPk !== undefined && (resolved.chatMessages ?? 0) <= SCOPE_TOKEN_LIMIT
  const tokenSender = resolved.senderPk !== undefined && (resolved.senderMessages ?? 0) <= SCOPE_TOKEN_LIMIT
  const required =
    mode === "every" ? groups.map((group) => `(${group.join(" OR ")})`).join(" AND ") : groups.flat().join(" OR ")
  const tokens = [...(tokenChat ? [`c${resolved.chatPk}`] : []), ...(tokenSender ? [`s${resolved.senderPk}`] : [])]
  let match = `(normalized_text : (${required}))`
  if (tokens.length > 0) match = `(${match} AND (scope : (${tokens.map(quoted).join(" AND ")})))`
  for (const term of query.excluded) {
    const excluded = wordTerm(term, false)
    if (excluded) match = `(${match} NOT (normalized_text : ${excluded}))`
  }

  const joined = {
    chat: resolved.chatPk !== undefined && !tokenChat,
    sender: resolved.senderPk !== undefined && !tokenSender,
  }
  const { where, params } = rowConditions(resolved, scope, joined)
  const order = newest ? "m.sent_at DESC, m.id DESC" : "f.rank, m.sent_at DESC, m.id DESC"
  const full = () =>
    context.database
      .prepare(
        `SELECT m.id AS pk, f.rank AS score
         FROM message_words f CROSS JOIN messages m CROSS JOIN chats c
         WHERE message_words MATCH ? AND f.rank MATCH '${UNSCOPED_RANK}' AND m.id = f.rowid AND c.id = m.chat_id
           AND ${where}
         ORDER BY ${order} LIMIT ?`,
      )
      .all(match, ...params, limit + 1)
      .map((row) => ({ pk: Number(row.pk), score: Number(row.score) }))

  if (newest || resolved.chatPk !== undefined || resolved.senderPk !== undefined || resolved.senderPks) {
    return page(context, full(), limit)
  }
  const ranked = context.database
    .prepare("SELECT rowid AS pk, rank AS score FROM message_words WHERE message_words MATCH ? ORDER BY rank LIMIT ?")
    .all(match, RANKED_FIRST * (limit + 1))
  if (ranked.length === 0) return empty
  const kept = new Map(
    context.database
      .prepare(
        `SELECT m.id AS pk, m.sent_at AS sent FROM messages m CROSS JOIN chats c
         WHERE m.id IN (${ranked.map((row) => Number(row.pk)).join(", ")}) AND c.id = m.chat_id AND ${where}`,
      )
      .all(...params)
      .map((row) => [Number(row.pk), Number(row.sent)]),
  )
  const survivors = ranked
    .filter((row) => kept.has(Number(row.pk)))
    .map((row) => ({ pk: Number(row.pk), score: Number(row.score), sent: kept.get(Number(row.pk)) ?? 0 }))
    .sort((a, b) => a.score - b.score || b.sent - a.sent || b.pk - a.pk)
  // Fewer than a page survived only because the top of the index was other accounts' rows.
  if (survivors.length > limit || ranked.length < RANKED_FIRST * (limit + 1)) return page(context, survivors, limit)
  return page(context, full(), limit)
}

/** A search of filters alone — `from:alice after:2026-01-01` — newest first (plan S5). */
export const matchFilters = (
  context: StoreContext,
  scope: SearchScope,
  { limit }: { limit: number },
): Page<ScoredHit> => {
  const resolved = resolve(context, scope)
  if (!resolved) return { items: [], hasMore: false }
  const { where, params } = rowConditions(resolved, scope, {
    chat: resolved.chatPk !== undefined,
    sender: resolved.senderPk !== undefined,
  })
  const rows = context.database
    .prepare(
      `SELECT m.id AS pk FROM messages m CROSS JOIN chats c
       WHERE c.id = m.chat_id AND ${where} ORDER BY m.sent_at DESC, m.id DESC LIMIT ?`,
    )
    .all(...params, limit + 1)
    .map((row) => ({ pk: Number(row.pk), score: null }))
  return page(context, rows, limit)
}

/** Step 5 (plan S4): the substring index over the raw text, newest first. Pieces under three letters are dropped. */
export const matchSubstring = (
  context: StoreContext,
  query: WordQuery,
  scope: SearchScope,
  { limit }: { limit: number },
): Page<ScoredHit> => {
  const empty = { items: [], hasMore: false }
  const pieces = (term: Term) =>
    (term.kind === "phrase" ? [term.words.join(" ")] : (term.text.match(/[\p{L}\p{N}]+/gu) ?? [])).filter(
      (piece) => [...piece].length >= 3,
    )
  const groups = query.required
    .map((group) => group.flatMap((term) => pieces(term).map(quoted).join(" AND ") || []).filter(Boolean))
    .filter((group) => group.length > 0)
  if (groups.length === 0) return empty
  const resolved = resolve(context, scope)
  if (!resolved) return empty
  let match = groups.map((group) => `(${group.map((one) => `(${one})`).join(" OR ")})`).join(" AND ")
  for (const term of query.excluded) {
    const excluded = pieces(term).map(quoted).join(" AND ")
    if (excluded) match = `(${match}) NOT (${excluded})`
  }
  const { where, params } = rowConditions(resolved, scope, {
    chat: resolved.chatPk !== undefined,
    sender: resolved.senderPk !== undefined,
  })
  const rows = context.database
    .prepare(
      `SELECT m.id AS pk FROM messages_fts f CROSS JOIN messages m CROSS JOIN chats c
       WHERE messages_fts MATCH ? AND m.id = f.rowid AND c.id = m.chat_id AND ${where}
       ORDER BY m.sent_at DESC, m.id DESC LIMIT ?`,
    )
    .all(match, ...params, limit + 1)
    .map((row) => ({ pk: Number(row.pk), score: null }))
  return page(context, rows, limit)
}

const VOCABULARY = "SELECT term, doc FROM message_words_vocab WHERE col = 'normalized_text'"

/**
 * The words the index knows, of those given: a whole word, or the beginning of one — otherwise
 * `квартир` would be "corrected" to `квартира` and lose `квартиру` (plan S4).
 */
export const knownTerms = ({ database }: StoreContext, terms: string[]): Set<string> => {
  const lookup = database.prepare(`${VOCABULARY} AND term >= ? AND term <= ? LIMIT 1`)
  return new Set(
    terms.filter((term) => {
      const word = normalize(term)
      return lookup.get(word, `${word}\u{10FFFF}`) !== undefined
    }),
  )
}

/**
 * Words sharing trigrams with `term`, between the lengths given, most shared first — and only those
 * the index still has, so a word whose messages were all deleted never comes back (plan S7).
 */
export const termCandidates = (
  { database }: StoreContext,
  pieces: string[],
  { shortest, longest }: { shortest: number; longest: number },
): { term: string; docs: number }[] => {
  if (pieces.length === 0) return []
  const candidates = database
    .prepare(
      `SELECT term, count(*) AS shared FROM search_term_trigrams
       WHERE trigram IN (${pieces.map(() => "?").join(", ")}) AND length BETWEEN ? AND ?
       GROUP BY term ORDER BY shared DESC, term LIMIT 200`,
    )
    .all(...pieces, shortest, longest)
  const docs = database.prepare(`${VOCABULARY} AND term = ?`)
  return candidates.flatMap((row) => {
    const held = docs.get(String(row.term))
    return held ? [{ term: String(row.term), docs: Number(held.doc) }] : []
  })
}
