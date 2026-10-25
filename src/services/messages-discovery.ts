import { CliError } from "@wirecat/cli-base"
import { implicitTextTerms, walkQuery } from "@wirecat/cli-base/query"
import { parseLocator } from "../domain/locator.js"
import type { Id } from "../domain/models.js"
import type { MessengerTraits } from "../ports/traits.js"
import { exhausted, QUERY_LIMITS } from "../search/lucene/types.js"
import { planQuestion, words } from "../search/question-plan.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import type { FoundMessage, SearchFound, SearchQuery } from "./messages.js"
import { searchCombined } from "./messages-combined.js"
import { prepareLucene, searchLucene } from "./messages-search.js"

/** How many of the messages nearest in meaning join the fusion: the benchmark's pool (performance/search/evidence-pipeline). */
export const MEANING_DEPTH = 100
const RRF_K = 60

export type MeaningRanked = (AccountKey & { chatId: Id; id: Id; score: number })[]

/** Why meaning was not searched, and the step that would make it searchable. */
export interface MeaningSkipped {
  reason: string
  /** Absent when the model itself failed: nothing the owner runs would fix it. */
  step?: "models.download" | "conversations.rebuild"
  model: string
}

/** The messages of these accounts nearest in meaning to the question, best first; or why there are none. */
export type MeaningLane = (
  question: string,
  accounts: AccountKey[],
) => Promise<{ model: string; ranked: MeaningRanked; partly?: MeaningSkipped } | { skipped: MeaningSkipped }>

export const searchDiscovery = async (
  store: MessageStore,
  account: AccountKey,
  asked: SearchQuery,
  messenger: Partial<Pick<MessengerTraits, "savedChatId" | "app" | "history" | "provider">> = {},
  meaning?: MeaningLane,
): Promise<SearchFound> => {
  // A question's own "?" would parse as a one-character wildcard and send it to strict search (BUG-395).
  const request =
    asked.ast !== undefined || asked.exact || !asked.text
      ? asked
      : { ...asked, text: asked.text.replace(/(?<=\p{L})\?(?=\s|$)/gu, "") }
  const original = await prepareLucene(store, account, request, messenger)
  const text = request.text ?? ""
  const plan = planQuestion(text, request.ast !== undefined || !!request.exact || !!request.newest)
  if (request.ast !== undefined || request.exact || request.newest || implicitTextTerms(text).size === 0)
    return searchLucene(store, account, request, messenger)
  const implicit = implicitTextTerms(text)
  if (
    !plan.changed &&
    walkQuery(original.execution.root).some(
      (node) =>
        (node.field === "text" || node.field === "exact") &&
        (node.operator !== "term" || node.field === "exact" || !implicit.has(node.span.start)),
    )
  )
    return searchLucene(store, account, request, messenger)
  const terms = [...new Set(plan.terms.concat(plan.aliases.flatMap((alias) => words(alias.split(" -> ")[1] ?? ""))))]
  if (!terms.length) return searchLucene(store, account, request, messenger)
  if (terms.length > 64) exhausted("discovery terms")
  // Before the clock starts: loading the model alone takes about a second of the word search's budget.
  const lane = meaning ? await meaning(text, original.scopeAccounts) : undefined
  const started = performance.now()
  const check = () => {
    if (request.signal?.aborted)
      throw new CliError("validation_error", "search was aborted", { reason: "query.aborted", complete: false })
    if (performance.now() - started > QUERY_LIMITS.milliseconds) exhausted("milliseconds")
  }
  const union = new Map<string, FoundMessage & { fused: number }>()
  let truncated = false
  const corrections = new Map<string, SearchFound["corrections"][number]>()
  const add = (items: FoundMessage[]) =>
    items.forEach((m, rank) => {
      const previous = union.get(m.locator)
      union.set(m.locator, { ...previous, ...m, fused: (previous?.fused ?? 0) + 1 / (60 + rank + 1) })
    })
  // Natural questions use one ranked partial lookup; repeated all-word lookups cannot rescue their wording gaps.
  for (const query of plan.changed ? [] : plan.queries) {
    check()
    const found = await searchCombined(store, account, { ...request, text: query, limit: 300 }, messenger, {
      candidateDepth: 300,
      rrfK: 60,
      rerank: "none",
      chatCap: 0,
    })
    add(found.items)
    for (const correction of found.corrections) corrections.set(correction.from, correction)
    truncated ||= found.hasMore || found.query.combined.truncated
  }
  check()
  const relaxed = `(${terms.join(" OR ")})${plan.scope ? ` ${plan.scope}` : ""}`
  const partialRequest = { ...request, text: relaxed, ast: undefined, limit: 300, context: 0, thread: undefined }
  const partial = await searchLucene(store, account, partialRequest, messenger)
  add(partial.items)
  truncated ||= partial.hasMore || union.size > 300
  let candidates = [...union.values()].sort((a, b) => b.fused - a.fused).slice(0, 300)
  const originals = new Set(candidates.map((m) => m.locator))
  const parentByLocator = new Map<string, FoundMessage>()
  let replyCount = 0
  if (candidates.length) {
    check()
    const proposed = await store.messages.directReplies(
      candidates.map((m) => {
        const locator = parseLocator(m.locator)
        return { account: { provider: locator.provider, account: locator.account }, chatId: m.chatId, id: m.id }
      }),
      100,
    )
    truncated ||= proposed.hasMore
    if (proposed.items.length) {
      const only = candidates
        .concat(proposed.items.map((m) => ({ ...m, fused: 0 })))
        .map((m) => {
          const { provider, account } = parseLocator(m.locator)
          return { provider, account, chatId: m.chatId, id: m.id }
        })
        .filter(
          (m) =>
            !request.only ||
            request.only.some(
              (key) =>
                key.provider === m.provider && key.account === m.account && key.chatId === m.chatId && key.id === m.id,
            ),
        )
      const eligible = await searchLucene(
        store,
        account,
        {
          ...request,
          text: plan.scope || undefined,
          ast: undefined,
          limit: 500,
          only,
          context: 0,
          thread: undefined,
        },
        messenger,
      )
      if (eligible.hasMore) exhausted("reply eligibility")
      const allowed = new Set(eligible.items.map((m) => m.locator))
      const parents = new Map(
        candidates.map((m) => [
          JSON.stringify([m.chatId, m.id, parseLocator(m.locator).account, parseLocator(m.locator).provider]),
          m,
        ]),
      )
      for (const child of proposed.items) {
        check()
        const owner = parseLocator(child.locator)
        const parent = parents.get(JSON.stringify([child.chatId, child.replyToId, owner.account, owner.provider]))
        if (!parent || !allowed.has(parent.locator) || !allowed.has(child.locator)) continue
        parentByLocator.set(child.locator, parent)
        if (!candidates.some((m) => m.locator === child.locator)) {
          candidates.push({ ...child, fused: parent.fused })
          replyCount++
        }
      }
    }
  }
  truncated ||= candidates.length > 300
  candidates = candidates.sort((a, b) => b.fused - a.fused).slice(0, 300)
  replyCount = candidates.filter((m) => !originals.has(m.locator)).length
  const stem = (w: string) => original.execution.stemmer?.stemToken(w) ?? w
  const stems = terms.map(stem)
  let bytes = 0
  const described = (m: FoundMessage & { fused: number }) => {
    check()
    const parent = parentByLocator.get(m.locator)
    const body = `${parent ? `${parent.text}\n` : ""}${m.text}`
    bytes += Buffer.byteLength(body)
    if (bytes > QUERY_LIMITS.bodyBytes) exhausted("bodyBytes")
    const tokens = new Set(words(body).map(stem))
    const matchedTerms = terms.filter((_, i) => tokens.has(stems[i] ?? ""))
    const missingTerms = terms.filter((_, i) => !tokens.has(stems[i] ?? ""))
    const coverage = matchedTerms.length / terms.length
    return {
      ...m,
      score: coverage * 4 + m.fused,
      discovery: {
        coverage,
        matchedTerms,
        missingTerms,
        ...(parent ? { parent: parent.locator } : {}),
      },
    }
  }
  candidates = candidates
    .map(described)
    .sort(
      (a, b) =>
        (b.score ?? 0) - (a.score ?? 0) ||
        Number(parentByLocator.has(b.locator)) - Number(parentByLocator.has(a.locator)),
    )
  let meaningCandidates = 0
  if (lane && "ranked" in lane) {
    const near = await nearEligible(store, account, request, messenger, lane.ranked, plan.scope)
    meaningCandidates = near.length
    candidates = fusedWithMeaning(candidates, near, described)
  }
  check()
  const items = await Promise.all(
    candidates.slice(0, request.limit).map(async ({ fused: _fused, ...m }) => {
      if (!request.context) return m
      check()
      const owner = parseLocator(m.locator)
      return {
        ...m,
        context: await store.messages.around({ provider: owner.provider, account: owner.account }, m.chatId, m.id, {
          before: request.context,
          after: request.context,
        }),
      }
    }),
  )
  if (!partial.query) throw new Error("Lucene discovery query metadata is missing")
  return {
    ...partial,
    corrections: items.some((m) => m.match === "corrected") ? [...corrections.values()] : [],
    items,
    hasMore: truncated || candidates.length > request.limit,
    query: {
      ...partial.query,
      discovery: {
        method: "lexical-partial",
        candidateDepth: 300,
        candidates: candidates.length,
        repliesAdded: replyCount,
        truncated,
        terms,
        queries: [...(plan.changed ? [] : plan.queries), relaxed],
        ...(lane && "ranked" in lane ? { meaning: { model: lane.model, candidates: meaningCandidates } } : {}),
      },
    },
    ...(lane && "skipped" in lane ? { meaningSkipped: lane.skipped } : {}),
    ...(lane && "partly" in lane && lane.partly ? { meaningSkipped: lane.partly } : {}),
  }
}

/** The nearest messages the question's filters allow, as hits, nearest first. */
const nearEligible = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchQuery,
  messenger: Partial<Pick<MessengerTraits, "savedChatId" | "app" | "history" | "provider">>,
  ranked: MeaningRanked,
  scope: string,
): Promise<(FoundMessage & { cosine: number })[]> => {
  const keyOf = (one: AccountKey & { chatId: Id; id: Id }) =>
    JSON.stringify([one.provider, one.account, one.chatId, one.id])
  const only = ranked
    .slice(0, MEANING_DEPTH)
    .filter((m) => !request.only || request.only.some((key) => keyOf(key) === keyOf(m)))
    .map(({ provider, account, chatId, id }) => ({ provider, account, chatId, id }))
  if (!only.length) return []
  const eligible = await searchLucene(
    store,
    account,
    { ...request, text: scope || undefined, ast: undefined, limit: only.length, only, context: 0, thread: undefined },
    messenger,
  )
  const hits = new Map(
    eligible.items.map((hit) => {
      const { provider, account } = parseLocator(hit.locator)
      return [keyOf({ provider, account, chatId: hit.chatId, id: hit.id }), hit]
    }),
  )
  return ranked.flatMap((m) => {
    const hit = hits.get(keyOf(m))
    return hit ? [{ ...hit, cosine: m.score }] : []
  })
}

/**
 * Reciprocal rank fusion of discovery's order and the meaning order, k = 60, as the benchmark's A2 arm: a hit
 * scores 1 / (k + rank) in each list it is in. Coverage is left out of the fused score, so a message that answers
 * in other words can rise above one that only repeats them.
 */
const fusedWithMeaning = (
  words: Ranked[],
  near: (FoundMessage & { cosine: number })[],
  described: (m: Ranked) => Ranked,
): Ranked[] => {
  const merged = new Map<string, { hit: Ranked; rrf: number }>()
  const by = (hit: Ranked, foundBy: ("words" | "meaning")[]): Ranked =>
    hit.discovery ? { ...hit, discovery: { ...hit.discovery, foundBy } } : hit
  words.forEach((hit, rank) => {
    merged.set(hit.locator, { hit: by(hit, ["words"]), rrf: 1 / (RRF_K + rank + 1) })
  })
  near.forEach(({ cosine: _, ...m }, rank) => {
    const share = 1 / (RRF_K + rank + 1)
    const held = merged.get(m.locator)
    if (held) {
      held.rrf += share
      held.hit = by(held.hit, ["words", "meaning"])
    } else merged.set(m.locator, { hit: by(described({ ...m, fused: 0 }), ["meaning"]), rrf: share })
  })
  return [...merged.values()].sort((a, b) => b.rrf - a.rrf).map(({ hit, rrf }) => ({ ...hit, score: rrf }))
}

type Ranked = FoundMessage & { fused: number }
