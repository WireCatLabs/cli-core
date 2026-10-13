import { CliError } from "@wirecat/cli-base"
import { counterFreshness } from "../domain/counters.js"
import { formatLocator, parseLocator } from "../domain/locator.js"
import {
  RANKING_TOKENIZER_VERSION,
  type RankingInput,
  type RankingTarget,
  rankingOptions,
} from "../domain/rankings-options.js"
import { rankingContextRange } from "../domain/rankings-range.js"
import type { QueryExecution, ResolvedNode } from "../search/lucene/resolved.js"
import type { AccountKey, RankedEvidence, RankedStoreFound, RankedStoreRow } from "../store/store.js"
import type { ServiceDeps } from "./deps.js"
import type { SearchQuery } from "./message-contracts.js"
import { coverageOf, prepareLucene, stemExecution } from "./messages-search.js"
import { type RankingSelection, rankingSelection, readRankingSelection } from "./rankings-selection.js"
import { refreshSearch, type SearchRefreshed } from "./search-refresh.js"
import { searchRecordOf } from "./searches.js"

export type RankingQuery = SearchQuery & RankingInput & { selection?: unknown }
export interface RankedRow extends Omit<RankedStoreRow, "provider" | "account" | "pk" | "score" | "graphComplete"> {
  account: AccountKey
  ranking: RankedStoreRow["score"]
  quality: {
    reactions: "known" | "partial" | "unknown"
    graph: "complete" | "partial" | "not_used"
    counterFreshness: "fresh" | "stale" | "partial" | "unknown"
  }
  drilldown: {
    selection: RankingSelection
    evidence: {
      command: string
      arguments: { message?: string; person?: string; selection: RankingSelection }
      components: string[]
    }
    show?: { command: "messages show" | "contacts show"; arguments: { message?: string; person?: string } }
    context?: { command: "messages context"; arguments: { message: string } }
  }
}
export interface RankingsService {
  top(target: RankingTarget, query: RankingQuery): Promise<RankingFound>
  evidence(
    target: RankingTarget,
    reference: string,
    selection: unknown,
    options: { component: string; limit: number; cursor?: string; signal?: AbortSignal },
  ): Promise<RankedEvidence>
}
export interface RankingFound extends Omit<RankedStoreFound, "items"> {
  items: RankedRow[]
  page: 1
  limit: number
  ranking: {
    target: RankingTarget
    measure: string
    order: "ascending" | "descending"
    preset: string | null
    weights: RankingInput["weights"]
    minMessages: number
    messageKind: string
    normalizationVersion: 1
    tokenizerVersion: number
    counterFreshness: "fresh" | "stale" | "partial" | "unknown"
    counters: "cumulative_snapshots"
    replies: "stored_events_in_query_period"
  }
  query: { language: "lucene-v1"; timezone: string; order: "ranking" }
  coverage: Awaited<ReturnType<typeof coverageOf>>["coverage"]
  completeness: Awaited<ReturnType<typeof coverageOf>>["completeness"]
  expandedDiscussionChats?: string[]
  refreshed?: SearchRefreshed
}

const empty = (): RankedStoreFound => ({
  total: 0,
  population: 0,
  eligible: 0,
  excludedMinimum: 0,
  excludedMissing: 0,
  excludedUnknownSender: 0,
  excludedUnknownKind: 0,
  items: [],
  maxima: {},
  hasMore: false,
})

export const rankingsService = (deps: ServiceDeps): RankingsService => ({
  top: async (target, request) => {
    if (request.language === "legacy" || request.pattern || request.newest || request.context)
      throw new CliError(
        "validation_error",
        "rankings use strict Lucene and ranking order, without regex/newest/context search modes",
      )
    if (request.limit < 1 || request.limit > 100 || !Number.isInteger(request.limit))
      throw new CliError("validation_error", "ranking limit must be 1–100")
    const pinned =
      request.selection === undefined ? undefined : await readRankingSelection(await deps.store(), request.selection)
    const inherited = { ...pinned?.options }
    if (request.measure !== undefined) {
      delete inherited.score
      delete inherited.weights
    }
    if (request.score !== undefined || request.weights !== undefined) delete inherited.measure
    const options = rankingOptions(target, { ...inherited, ...request })
    const store = await deps.store()
    const account = await deps.account()
    let prepared: Awaited<ReturnType<typeof prepareLucene>>
    if (pinned !== undefined) {
      if (request.syncFirst)
        throw new CliError(
          "validation_error",
          "a pinned ranking selection reads held data; use an ordinary query for --sync-first",
        )
      const selection = pinned
      if (selection.target !== target)
        throw new CliError("validation_error", "saved selection belongs to a different ranking target")
      const execution: QueryExecution = {
        ...selection.execution,
        limit: request.limit,
        ...(request.signal ? { signal: request.signal } : {}),
      }
      await stemExecution(execution, store)
      if (request.text?.trim()) {
        const extra = await prepareLucene(
          store,
          account,
          {
            text: request.text,
            accounts: execution.accounts,
            timezone: selection.timezone,
            limit: request.limit,
            language: "lucene",
            ...(request.exact ? { exact: true } : {}),
          },
          deps.messenger,
        )
        execution.root = {
          kind: "boolean",
          span: { start: 0, end: 0 },
          clauses: [
            { occur: "must", node: execution.root },
            { occur: "must", node: extra.execution.root },
          ],
        }
      }
      prepared = {
        execution,
        timezone: selection.timezone,
        scopeAccounts: execution.accounts,
        wordsReady: (await store.searchIndexState())?.ready === true,
        stemsReady: (await store.stemsState())?.ready === true,
        ...(selection.contextChat ? { selectedChat: selection.contextChat } : {}),
      }
    } else prepared = await prepareLucene(store, account, { ...request, language: "lucene" }, deps.messenger)
    if (
      options.components.some((name) =>
        [
          "replies",
          "replies-from-others",
          "replies-from-others-per-message",
          "thread-size",
          "threads",
          "answers",
          "answer-time",
        ].includes(name),
      ) ||
      options.messageKind === "comments"
    )
      rankingContextRange(prepared.execution.root)
    const refreshed = await refreshSearch(deps, request)
    if (request.syncFirst)
      prepared = await prepareLucene(store, account, { ...request, language: "lucene" }, deps.messenger)
    if (!store.rankQuery)
      throw new CliError("validation_error", "this store does not support rankings — upgrade cli-messaging")
    const contextChat = prepared.selectedChat
    let expandedDiscussionChats: string[] = []
    if (options.messageKind === "comments" && contextChat && store.rankingDiscussionChats) {
      expandedDiscussionChats = await store.rankingDiscussionChats(contextChat.account, contextChat.chatId)
      if (expandedDiscussionChats.length) {
        const expand = (node: ResolvedNode): ResolvedNode => {
          if (node.kind === "boolean")
            return { ...node, clauses: node.clauses.map((clause) => ({ ...clause, node: expand(clause.node) })) }
          const chat = node.resolution?.chat
          if (
            node.field !== "chat" ||
            !chat ||
            chat.account.provider !== contextChat.account.provider ||
            chat.account.account !== contextChat.account.account ||
            chat.chatId !== contextChat.chatId
          )
            return node
          return {
            kind: "boolean",
            span: node.span,
            clauses: [
              node,
              ...expandedDiscussionChats.map((chatId) => ({
                ...node,
                value: chatId,
                resolution: { chat: { account: contextChat.account, chatId } },
              })),
            ].map((node) => ({ occur: "should", node })),
          }
        }
        const chatScope: ResolvedNode = {
          kind: "boolean",
          span: { start: 0, end: 0 },
          clauses: [contextChat.chatId, ...expandedDiscussionChats].map((chatId) => ({
            occur: "should",
            node: {
              kind: "predicate",
              field: "chat",
              operator: "term",
              value: chatId,
              span: { start: 0, end: 0 },
              resolution: { chat: { account: contextChat.account, chatId } },
            },
          })),
        }
        const root: ResolvedNode = {
          kind: "boolean",
          span: { start: 0, end: 0 },
          clauses: [
            { occur: "must", node: expand(prepared.execution.root) },
            { occur: "must", node: chatScope },
          ],
        }
        prepared = { ...prepared, execution: { ...prepared.execution, root, chat: undefined } }
      }
    }
    const found = prepared.scopeAccounts.length
      ? await store.rankQuery(prepared.execution, {
          options,
          timezone: prepared.timezone,
          ...(contextChat ? { contextChat } : {}),
        })
      : empty()
    const coverage = await coverageOf(store, prepared)
    if (expandedDiscussionChats.length && contextChat) {
      coverage.completeness = (
        await store.chatCompleteness(contextChat.account, [contextChat.chatId, ...expandedDiscussionChats])
      ).map((chat) => ({ ...chat, ...contextChat.account }))
      coverage.coverage = {
        ...coverage.coverage,
        coveredChats: coverage.completeness.length,
        state: coverage.completeness.every(({ state }) => state === "complete") ? "complete" : "partial",
      }
    }
    const selectionOptions: RankingInput = {
      ...(options.measure === "score"
        ? {
            ...(options.preset !== "custom" && options.preset !== null ? { score: options.preset } : {}),
            weights: options.weights,
          }
        : { measure: options.measure }),
      ...(target === "contacts" ? { minMessages: options.minMessages } : {}),
      messageKind: options.messageKind,
    }
    const items = found.items.map((row): RankedRow => {
      const entityAccount = { provider: row.provider, account: row.account }
      const entity = { account: entityAccount, id: row.id, ...(row.chatId === null ? {} : { chatId: row.chatId }) }
      const selection = rankingSelection(
        target,
        selectionOptions,
        prepared.timezone,
        prepared.execution,
        entity,
        contextChat,
      )
      const message =
        row.chatId === null ? undefined : formatLocator({ ...entityAccount, chat: row.chatId, message: row.id })
      const { provider: _provider, account: _account, pk: _pk, score, graphComplete, ...data } = row
      return {
        ...data,
        account: entityAccount,
        ranking: score,
        quality: {
          reactions: row.knownReactions === 0 ? "unknown" : row.unknownReactions > 0 ? "partial" : "known",
          graph: graphComplete === undefined ? "not_used" : graphComplete ? "complete" : "partial",
          counterFreshness: counterFreshness(
            (row.counterObservations ?? []).filter((one) =>
              options.components.some((component) => component.startsWith(one.counter)),
            ),
          ),
        },
        drilldown: {
          selection,
          evidence: {
            command: `stats ${target} evidence`,
            arguments: { ...(message ? { message } : { person: row.id }), selection },
            components: target === "contacts" ? [...new Set(["messages", ...options.components])] : options.components,
          },
          ...(message
            ? {
                show: { command: "messages show" as const, arguments: { message } },
                context: { command: "messages context" as const, arguments: { message } },
              }
            : { show: { command: "contacts show" as const, arguments: { person: row.id } } }),
        },
      }
    })
    if (deps.history !== false) {
      const params = {
        ...(request.selection === undefined ? {} : { selection: request.selection }),
        ...(request.text === undefined ? {} : { text: request.text }),
        ...(request.ast === undefined ? {} : { ast: request.ast }),
        ...(request.chat === undefined ? {} : { chat: request.chat }),
        ...(request.source === undefined ? {} : { source: request.source }),
        ...(request.exact ? { exact: true } : {}),
        language: "lucene" as const,
        timezone: prepared.timezone,
        limit: request.limit,
        target,
        ...selectionOptions,
      }
      await store
        .recordSearch(searchRecordOf(target === "messages" ? "message-top" : "author-top", params), {
          ...(request.saved ? { saved: request.saved } : {}),
        })
        .catch(() => undefined)
    }
    return {
      ...found,
      items,
      ...coverage,
      page: 1,
      limit: request.limit,
      ranking: {
        target,
        measure: options.measure,
        order: options.order,
        preset: options.preset,
        weights: options.weights,
        minMessages: options.minMessages,
        messageKind: options.messageKind,
        normalizationVersion: 1,
        tokenizerVersion: RANKING_TOKENIZER_VERSION,
        counterFreshness: counterFreshness(
          items.flatMap((row) =>
            (row.counterObservations ?? []).filter((one) =>
              options.components.some((component) => component.startsWith(one.counter)),
            ),
          ),
        ),
        counters: "cumulative_snapshots",
        replies: "stored_events_in_query_period",
      },
      query: { language: "lucene-v1", timezone: prepared.timezone, order: "ranking" },
      ...(expandedDiscussionChats.length ? { expandedDiscussionChats } : {}),
      ...(refreshed ? { refreshed } : {}),
    }
  },
  evidence: async (target, reference, input, options) => {
    const store = await deps.store()
    const selection = await readRankingSelection(store, input)
    if (selection.target !== target)
      throw new CliError("validation_error", "selection belongs to a different ranking view")
    if (target === "messages") {
      const locator = parseLocator(reference)
      const entity = selection.entity
      if (
        locator.provider !== entity.account.provider ||
        locator.account !== entity.account.account ||
        locator.chat !== entity.chatId ||
        locator.message !== entity.id
      )
        throw new CliError("validation_error", "message does not match this ranking selection")
    } else if (reference !== selection.entity.id)
      throw new CliError("validation_error", "person does not match this ranking selection")
    if (!store.rankingEvidence)
      throw new CliError("validation_error", "this store does not support ranking evidence — upgrade cli-messaging")
    const execution: QueryExecution = {
      ...selection.execution,
      limit: 1,
      ...(options.signal ? { signal: options.signal } : {}),
    }
    await stemExecution(execution, store)
    return store.rankingEvidence(execution, {
      options: rankingOptions(target, selection.options),
      timezone: selection.timezone,
      ...(selection.contextChat ? { contextChat: selection.contextChat } : {}),
      target: selection.entity,
      component: options.component,
      limit: options.limit,
      ...(options.cursor ? { cursor: options.cursor } : {}),
    })
  },
})
