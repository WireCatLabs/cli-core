import { CliError } from "@wirecat/cli-base"
import type { Messenger } from "../cli/messenger/context.js"
import { parseLocator } from "../domain/locator.js"
import type { Page } from "../domain/models.js"
import { correctWords } from "../search/correct.js"
import { implicitTextTerms } from "../search/lucene/parser.js"
import { PRESET_VERSION } from "../search/lucene/presets.js"
import { FIELD_VERSION } from "../search/lucene/registry.js"
import type { QueryExecution, ResolvedNode } from "../search/lucene/resolved.js"
import { exhausted, QUERY_LIMITS, walkQuery } from "../search/lucene/types.js"
import { normalize } from "../store/normalize.js"
import type { AccountKey, MessageStore, ScoredHit } from "../store/store.js"
import { withExcerpt } from "./excerpt.js"
import type { FoundMessage, SearchFound, SearchQuery } from "./messages.js"
import type { QueryMetadata } from "./messages-search.js"
import { coverageOf, prepareLucene } from "./messages-search.js"

type Source = "words" | "beginnings" | "corrected"
export interface CombinedOptions {
  candidateDepth: number
  rrfK: number
  rerank: "none" | "coverage" | "proximity" | "phrase" | "all"
  chatCap: number
}
export const COMBINED_DEFAULTS: CombinedOptions = { candidateDepth: 300, rrfK: 60, rerank: "all", chatCap: 0 }
export type CombinedFound = SearchFound & {
  query: QueryMetadata & { combined: { candidateDepth: number; truncated: boolean; expanded: boolean } }
}
type Ranked = ScoredHit & { match: Source; matches: Source[]; fused: number; score: number }
const tokensOf = (text: string) => normalize(text).match(/[\p{L}\p{N}\p{Co}\p{M}]+/gu) ?? []

/** Internal measured entry point; public search stays on its existing compatibility paths. */
export const searchCombined = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchQuery,
  messenger: Partial<Pick<Messenger, "savedChatId" | "app" | "history" | "provider">> = {},
  options: CombinedOptions = COMBINED_DEFAULTS,
): Promise<CombinedFound> => {
  if (request.pattern || request.language === "legacy")
    throw new CliError("validation_error", "combined search takes Lucene text or AST, not legacy or JavaScript regex")
  if (request.thread) throw new CliError("validation_error", "internal combined evaluation does not hydrate threads")
  if (
    !Number.isInteger(options.candidateDepth) ||
    options.candidateDepth < 1 ||
    options.candidateDepth > 1000 ||
    !Number.isFinite(options.rrfK) ||
    options.rrfK <= 0 ||
    !Number.isInteger(options.chatCap) ||
    options.chatCap < 0 ||
    !["none", "coverage", "proximity", "phrase", "all"].includes(options.rerank)
  )
    throw new CliError("validation_error", "invalid internal combined search bounds")
  const prepared = await prepareLucene(store, account, request, messenger)
  const execute = store.matchQuery
  if (!execute) throw new CliError("validation_error", "this store does not support Lucene search")
  const execution = prepared.execution
  const started = performance.now()
  const check = () => {
    if (request.signal?.aborted)
      throw new CliError("validation_error", "search was aborted", { reason: "query_aborted", complete: false })
    if (performance.now() - started > QUERY_LIMITS.milliseconds) exhausted("milliseconds")
  }
  check()
  const spans =
    request.ast === undefined && !request.exact && request.text !== undefined
      ? implicitTextTerms(request.text)
      : new Set<number>()
  const eligible = walkQuery(execution.root).filter(
    (leaf) =>
      spans.has(leaf.span.start) &&
      leaf.field === "text" &&
      leaf.operator === "term" &&
      tokensOf(leaf.value).length === 1 &&
      /^[\p{L}\p{N}]+$/u.test(normalize(leaf.value)),
  )
  const expanding = eligible.length > 0
  const depth = Math.max(request.limit, options.candidateDepth)
  const queryTerms = walkQuery(execution.root)
    .filter(
      (leaf) =>
        (leaf.field === "text" || leaf.field === "exact") && (leaf.operator === "term" || leaf.operator === "phrase"),
    )
    .flatMap((leaf) => tokensOf(leaf.value))
  const corrections = expanding
    ? await correctWords(store, [...new Set(eligible.map((leaf) => normalize(leaf.value)))])
    : new Map<string, string[]>()
  check()
  const bySpan = new Map(eligible.map((leaf) => [leaf.span.start, leaf]))
  const transform = (node: ResolvedNode, source: Source, exact = false): ResolvedNode => {
    if (node.kind === "boolean")
      return {
        ...node,
        clauses: node.clauses.map((clause) => ({ ...clause, node: transform(clause.node, source, exact) })),
      }
    if (exact && node.field === "text" && (node.operator === "term" || node.operator === "phrase"))
      return { ...node, field: "exact" }
    if (!bySpan.has(node.span.start)) return node
    if (source === "beginnings" && [...normalize(node.value)].length >= 3)
      return { ...node, operator: "wildcard", value: `${normalize(node.value)}*` }
    if (source !== "corrected") return node
    const fixes = corrections.get(normalize(node.value))
    if (!fixes) return node
    const clauses = fixes.map((value) => ({ occur: "should" as const, node: { ...node, field: "exact", value } }))
    return { kind: "boolean", clauses, span: node.span }
  }
  const read = async (root: ResolvedNode, limit: number): Promise<Page<ScoredHit>> => {
    check()
    const nodes = (node: ResolvedNode): number =>
      node.kind === "predicate" ? 1 : 1 + node.clauses.reduce((sum, clause) => sum + nodes(clause.node), 0)
    if (nodes(root) > QUERY_LIMITS.nodes) exhausted("nodes")
    const found = execution.accounts.length
      ? await execute({ ...execution, root, limit })
      : { items: [], hasMore: false }
    check()
    return found
  }
  // Explicit syntax and AST retain the exact production execution and order.
  if (!expanding) {
    const found = await read(execution.root, request.limit)
    return finish(found.items, found.hasMore, [], false, false)
  }
  const exact = await read(transform(execution.root, "words", true), depth)
  const stemmed = await read(execution.root, depth)
  const prefix = await read(transform(execution.root, "beginnings"), depth)
  const fixed = corrections.size
    ? await read(transform(execution.root, "corrected"), depth)
    : { items: [], hasMore: false }
  const fixedPrefixRoot = transform(execution.root, "corrected")
  const correctedBeginnings = (node: ResolvedNode): ResolvedNode =>
    node.kind === "boolean"
      ? { ...node, clauses: node.clauses.map((clause) => ({ ...clause, node: correctedBeginnings(clause.node) })) }
      : bySpan.has(node.span.start) && [...normalize(node.value)].length >= 3
        ? { ...node, field: "exact", operator: "wildcard", value: `${normalize(node.value)}*` }
        : node
  const fixedPrefix = corrections.size
    ? await read(correctedBeginnings(fixedPrefixRoot), depth)
    : { items: [], hasMore: false }
  const ranked = new Map<string, Ranked>()
  const add = (lists: Page<ScoredHit>[], source: Source) => {
    const shares = new Map<string, { hit: ScoredHit; share: number }>()
    for (const list of lists)
      list.items.forEach((hit, rank) => {
        const share = 1 / (options.rrfK + rank + 1)
        const old = shares.get(hit.locator)
        if (!old || share > old.share) shares.set(hit.locator, { hit, share })
      })
    for (const { hit, share } of shares.values()) {
      const old = ranked.get(hit.locator)
      if (old && source === "beginnings") continue
      if (old) {
        old.fused += share
        old.matches.push(source)
      } else ranked.set(hit.locator, { ...hit, match: source, matches: [source], fused: share, score: 0 })
    }
  }
  add([exact, stemmed], "words")
  add([prefix], "beginnings")
  add([fixed, fixedPrefix], "corrected")
  let bytes = 0
  const work = { used: 0 }
  for (const hit of ranked.values()) {
    bytes += new TextEncoder().encode(hit.text).byteLength
    if (bytes > QUERY_LIMITS.bodyBytes) exhausted("body bytes")
    check()
    hit.score = hit.fused * (options.rrfK + 1) + signals(hit, queryTerms, corrections, execution, options.rerank, work)
    check()
  }
  const sorted = [...ranked.values()].sort((a, b) =>
    request.newest
      ? b.timestamp.localeCompare(a.timestamp) || a.locator.localeCompare(b.locator)
      : b.score - a.score ||
        b.fused - a.fused ||
        b.timestamp.localeCompare(a.timestamp) ||
        a.locator.localeCompare(b.locator),
  )
  const ordered: Ranked[] = []
  const deferred: Ranked[] = []
  const counts = new Map<string, number>()
  const cap =
    execution.chat || request.newest || !options.chatCap ? 0 : Math.ceil((options.chatCap * request.limit) / 10)
  for (const hit of sorted) {
    const { provider, account } = parseLocator(hit.locator)
    const chat = JSON.stringify([provider, account, hit.chatId])
    const count = counts.get(chat) ?? 0
    if (cap && count >= cap) deferred.push(hit)
    else {
      ordered.push(hit)
      counts.set(chat, count + 1)
    }
  }
  ordered.push(...deferred)
  const truncated = [exact, stemmed, prefix, fixed, fixedPrefix].some((page) => page.hasMore)
  const listed = ordered.slice(0, request.limit)
  const usedCorrections = listed.some((hit) => hit.matches.includes("corrected"))
    ? [...corrections]
        .filter(([, fixes]) =>
          listed.some(
            (hit) =>
              hit.matches.includes("corrected") &&
              tokensOf(hit.text).some((token) => fixes.some((fix) => token.startsWith(fix))),
          ),
        )
        .map(([from, to]) => ({ from, to }))
    : []
  return finish(
    listed.map(({ fused: _fused, ...hit }) => hit),
    ordered.length > request.limit || truncated,
    usedCorrections,
    truncated,
    true,
  )

  async function finish(
    items: FoundMessage[],
    hasMore: boolean,
    listed: { from: string; to: string[] }[],
    truncated: boolean,
    expanded: boolean,
  ): Promise<CombinedFound> {
    const { completeness, coverage } =
      request.kind === "mail" ? { completeness: [], coverage: undefined } : await coverageOf(store, prepared, messenger)
    const hydrated = await Promise.all(
      items.map(async (item) => {
        const hit = withExcerpt(item, request.text ?? "")
        if (!request.context) return hit
        const { provider, account } = parseLocator(hit.locator)
        return {
          ...hit,
          context: await store.around({ provider, account }, hit.chatId, hit.id, {
            before: request.context,
            after: request.context,
          }),
        }
      }),
    )
    return {
      items: hydrated,
      hasMore,
      corrections: listed,
      completeness,
      ...(coverage ? { coverage } : {}),
      wordsReady: prepared.wordsReady,
      stemsReady: prepared.stemsReady,
      query: {
        language: "lucene-v1",
        version: 1,
        fieldsVersion: FIELD_VERSION,
        presetVersion: PRESET_VERSION,
        timezone: prepared.timezone,
        order: request.newest ? "newest" : "relevance",
        ...(prepared.stemming ? { stemming: prepared.stemming } : {}),
        combined: { candidateDepth: depth, truncated, expanded },
      },
    }
  }
}

const signals = (
  hit: ScoredHit,
  terms: string[],
  corrections: Map<string, string[]>,
  execution: QueryExecution,
  mode: CombinedOptions["rerank"],
  work: { used: number },
): number => {
  if (mode === "none" || !terms.length) return 0
  const tokens = tokensOf(hit.text)
  work.used += terms.length * tokens.length
  if (work.used > QUERY_LIMITS.work) exhausted("work")
  const positions = terms.map((term) =>
    tokens.flatMap((token, index) => {
      const strength =
        token === term
          ? 1
          : execution.stemmer?.stemToken(token) === execution.stemmer?.stemToken(term) && execution.stemmer
            ? 0.9
            : [...term].length >= 3 && token.startsWith(term)
              ? 0.8
              : corrections.get(term)?.some((fix) => token.startsWith(fix))
                ? 0.7
                : 0
      return strength ? [{ index, strength }] : []
    }),
  )
  const coverage =
    positions.reduce(
      (sum, matches) => sum + matches.reduce((maximum, match) => Math.max(maximum, match.strength), 0),
      0,
    ) / terms.length
  const events = positions
    .flatMap((matches, term) => matches.map(({ index }) => ({ index, term })))
    .sort((a, b) => a.index - b.index)
  const held = new Map<number, number>()
  let left = 0,
    span = Infinity
  for (const [right, event] of events.entries()) {
    held.set(event.term, (held.get(event.term) ?? 0) + 1)
    while (held.size === terms.length && left <= right) {
      const first = events[left] as { index: number; term: number }
      span = Math.min(span, event.index - first.index + 1)
      const count = (held.get(first.term) ?? 1) - 1
      if (count) held.set(first.term, count)
      else held.delete(first.term)
      left++
    }
  }
  const proximity = Number.isFinite(span) ? Math.min(1, terms.length / span) : 0
  const phrase = tokens.some((_, index) => terms.every((term, offset) => tokens[index + offset] === term)) ? 1 : 0
  return mode === "coverage"
    ? coverage * 4
    : mode === "proximity"
      ? proximity
      : mode === "phrase"
        ? phrase
        : coverage * 4 + proximity + phrase
}
