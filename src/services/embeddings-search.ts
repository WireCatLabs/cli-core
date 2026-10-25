import { CliError } from "@wirecat/cli-base"
import { formatLocator, parseLocator } from "../domain/locator.js"
import type { Id } from "../domain/models.js"
import { meaningFloor } from "../embeddings/models.js"
import { QUERY_LIMITS, searchError } from "../search/lucene/types.js"
import { type AccountKey, type ConversationHit, type ConversationSummary, threadConversation } from "../store/store.js"
import type { ServiceDeps } from "./deps.js"
import type { ChatReadiness, EmbeddingsService, FoundConversation, SearchReadiness } from "./embeddings.js"
import {
  embeddingsMaintenance,
  embeddingTarget,
  isStale,
  notBuiltError,
  readinessOf,
  shaped,
  withEmbedder,
} from "./embeddings-maintenance.js"
import { storedChatId } from "./message-resolution.js"
import { type Prepared, prepareLucene } from "./messages-search.js"
import { MAIL } from "./search-kind.js"
import { refreshSearch } from "./search-refresh.js"

/** How deep each list is read before the two are merged. */
const CANDIDATES = 50
/** Messages the word search reads: one long thread can hold many of them. */
const WORD_HITS = 200
/** Reciprocal rank fusion's usual constant (phase 5 E9). */
const RRF_K = 60

export const embeddingsSearch = (deps: ServiceDeps): Pick<EmbeddingsService, "search" | "related"> => {
  const command = deps.messenger.app.command

  /**
   * The conversations holding messages that share a word with the query, best message first. Every word
   * is one side of an OR, so a sentence ranks what shares any of it, and nothing in it is read as a filter.
   * Only whole words and their beginnings count: a corrected spelling or a piece of a word would pass a
   * near-miss off as a match, which is what the meaning half is for.
   */
  const byWords = async (
    query: string,
    prepared: Prepared,
    conversations: string[] | undefined,
    since: string | undefined,
  ) => {
    const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    const outside = new Map<string, { account: AccountKey; chats: Set<Id> }>()
    if (!words.length || !prepared.scopeAccounts.length)
      return { hits: [], outside, sources: new Map<string, AccountKey>() }
    const store = await deps.store()
    const lexical = await prepareLucene(
      store,
      await deps.account(),
      {
        text: words.map((word) => (word.length >= 3 ? `${word}*` : `"${word}"`)).join(" OR "),
        accounts: prepared.scopeAccounts,
        limit: WORD_HITS,
      },
      deps.messenger,
    )
    const { items } = await store.queries.matchQuery({
      ...lexical.execution,
      ...(prepared.selectedChat ? { chat: prepared.selectedChat } : {}),
      ...(conversations === undefined ? {} : { conversationIds: conversations }),
      ...(since === undefined ? {} : { conversationSince: Date.parse(since) }),
    })
    const summaries = new Map<number, ConversationSummary>()
    const sources = new Map<string, AccountKey>()
    for (const account of prepared.scopeAccounts) {
      const refs = items.flatMap((hit, index) => {
        const at = parseLocator(hit.locator)
        return at.provider === account.provider && at.account === account.account ? [{ hit, index }] : []
      })
      const found = await store.conversations.conversationsOfMessages(
        account,
        refs.map(({ hit }) => ({ chatId: hit.chatId, messageId: hit.id })),
      )
      const chats = new Set<Id>()
      refs.forEach(({ hit, index }, at) => {
        const summary = found[at]
        if (summary) {
          summaries.set(index, summary)
          sources.set(summary.id, account)
        } else chats.add(hit.chatId)
      })
      outside.set(JSON.stringify(account), { account, chats })
    }
    const ranked = items.flatMap(({ id, score }, index) => {
      const summary = summaries.get(index)
      return summary ? [{ summary, chunk: { firstMessageId: id, lastMessageId: id }, score }] : []
    })
    // Mail in its own tables has no conversations: each email answers as its thread, ranked with the messages.
    const mailAccounts = prepared.scopeAccounts.filter(({ provider }) => provider === MAIL)
    if (mailAccounts.length && conversations === undefined) {
      const mail = await store.queries
        .matchQuery({
          ...lexical.execution,
          accounts: mailAccounts,
          corpus: "mail",
          ...(prepared.selectedChat ? { chat: prepared.selectedChat } : {}),
        })
        .catch((error: unknown) => {
          if (error instanceof CliError && error.code === "validation_error") return { items: [] }
          throw error
        })
      for (const account of mailAccounts) {
        const found = mail.items.filter((hit) => {
          const at = parseLocator(hit.locator)
          return at.account === account.account && (since === undefined || hit.timestamp >= since)
        })
        if (!found.length) continue
        const { id } = await store.accounts.storedAccount(account)
        const places = new Map(
          (
            await store.mail.inThreads(
              id,
              found.map((hit) => hit.id),
            )
          ).map((place) => [place.externalId, place]),
        )
        for (const hit of found) {
          const place = places.get(hit.id)
          if (!place) continue
          const summary = threadConversation(place, Date.now())
          sources.set(summary.id, account)
          ranked.push({ summary, chunk: { firstMessageId: hit.id, lastMessageId: hit.id }, score: hit.score })
        }
      }
      ranked.sort((a, b) => (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY))
    }
    const seen = new Set<string>()
    const hits = ranked.flatMap(({ summary, chunk }) => {
      if (seen.has(summary.id)) return []
      seen.add(summary.id)
      return [{ summary, chunk }]
    })
    return { hits, outside, sources }
  }

  return {
    search: async (
      query,
      { chat, model: choice, since, limit, filter, source, timezone, syncFirst, signal, refresh },
    ) => {
      if (!query.trim())
        searchError("query.invalid-syntax", { start: 0, end: query.length }, "give words to search for")
      if (new TextEncoder().encode(query).length > QUERY_LIMITS.bytes)
        searchError("query.too-large", { start: 0, end: query.length }, "query is longer than 8 KiB")
      const refreshed = await refreshSearch(deps, {
        chat,
        limit,
        syncFirst,
        signal,
        text: filter,
        source,
        timezone,
      })
      const locallyRefreshed = refresh
        ? await embeddingsMaintenance(deps).refresh({ ...refresh, messages: false })
        : undefined
      const store = await deps.store()
      const account = await deps.account()
      const target = embeddingTarget(deps, choice)
      const stop = Date.now() + 200
      await store.searchIndex.fillSearchIndex({ until: () => Date.now() >= stop })
      await store.searchIndex.fillStems({ until: () => Date.now() >= stop })
      const prepared = await prepareLucene(
        store,
        account,
        {
          ...(filter === undefined ? {} : { text: filter }),
          ...(source === undefined ? {} : { source }),
          ...(chat === undefined ? {} : { chat }),
          ...(timezone === undefined ? {} : { timezone }),
          limit,
        },
        deps.messenger,
      )
      const eligibility =
        filter === undefined ? undefined : await store.queries.conversationEligibility(prepared.execution)
      const selected = prepared.selectedChat
      const scopeOf = (one: AccountKey) =>
        selected
          ? selected.account.provider === one.provider && selected.account.account === one.account
            ? { chatId: selected.chatId }
            : null
          : {}
      const words = await byWords(query, prepared, eligibility?.conversations, since)
      const meaning: ConversationHit[] = []
      const sources = words.sources
      if (target.installed && prepared.scopeAccounts.length && eligibility?.conversations.length !== 0) {
        await withEmbedder(deps, target, choice, {}, async (embedder) => {
          const [vector] = await embedder.embed([query], "query")
          for (const one of prepared.scopeAccounts) {
            const scope = scopeOf(one)
            if (scope === null) continue
            const hits = await store.vectors.nearestConversations(one, {
              ...scope,
              ...(since === undefined ? {} : { since }),
              model: target.key,
              limit: Math.max(limit, CANDIDATES),
              query: vector as Float32Array,
              ...(eligibility ? { conversations: eligibility.conversations } : {}),
            })
            for (const hit of hits) sources.set(hit.summary.id, one)
            meaning.push(...hits)
            const images = await store.vectors.nearestImages(one, {
              ...scope,
              ...(since === undefined ? {} : { since }),
              model: target.key,
              limit: Math.max(limit, CANDIDATES),
              query: vector as Float32Array,
            })
            for (const hit of images) {
              if (eligibility && !eligibility.conversations.includes(hit.summary.id)) continue
              sources.set(hit.summary.id, one)
              meaning.push(hit)
            }
          }
        })
      }
      meaning.sort((a, b) => b.score - a.score)
      const scoped: { source: AccountKey; readiness: SearchReadiness }[] = []
      const elsewhere: string[] = []
      for (const one of prepared.scopeAccounts) {
        const scope = scopeOf(one)
        if (scope === null) continue
        const eligibleChats = eligibility?.chats
          .filter(({ account }) => account.provider === one.provider && account.account === one.account)
          .map(({ chat }) => chat)
        const rows =
          eligibleChats === undefined
            ? await store.vectors.readiness(one, { ...scope, model: target.key, searchableOnly: true })
            : (
                await Promise.all(
                  eligibleChats.map((chatId) => store.vectors.readiness(one, { chatId, model: target.key })),
                )
              ).flat()
        const readiness = searchReadiness(
          rows.map(shaped),
          target.installed,
          words.outside.get(JSON.stringify(one))?.chats ?? new Set(),
        )
        scoped.push({ source: one, readiness })
        const other = await store.vectors.embeddedOnlyElsewhere(one, { ...scope, model: target.key })
        elsewhere.push(
          ...other
            .filter((id) => eligibleChats === undefined || eligibleChats.includes(id))
            .map((id) =>
              prepared.scopeAccounts.length > 1
                ? [one.provider, one.account, id].map(encodeURIComponent).join("/")
                : id,
            ),
        )
      }
      const readiness: SearchReadiness = { searchedByMeaning: [], wordsOnly: [], partial: [], stale: [], notBuilt: [] }
      for (const key of ["searchedByMeaning", "wordsOnly", "partial", "stale", "notBuilt"] as const)
        readiness[key] = [
          ...new Set(
            scoped.flatMap(({ source, readiness }) =>
              readiness[key].map((id) =>
                scoped.length > 1 ? [source.provider, source.account, id].map(encodeURIComponent).join("/") : id,
              ),
            ),
          ),
        ].sort()
      if (scoped.length > 1) readiness.scopes = scoped
      return {
        accounts: prepared.scopeAccounts,
        model: target.id,
        meaning: target.installed ? "searched" : "unavailable",
        hits: fused(meaning, words.hits, meaningFloor(target.key))
          .slice(0, limit)
          .map((hit) => {
            const source = sources.get(hit.summary.id) as AccountKey
            return {
              ...hit,
              source,
              locator: formatLocator({ ...source, chat: hit.summary.chatId, message: hit.chunk.firstMessageId }),
            }
          }),
        readiness,
        ...(locallyRefreshed ? { prepared: locallyRefreshed } : {}),
        ...(refreshed
          ? { refreshed, coverage: { state: refreshed.complete ? ("partial" as const) : ("stale" as const) } }
          : {}),
        embeddedOnlyElsewhere: elsewhere,
      }
    },

    related: async (chat, message, { model: choice, limit }) => {
      const store = await deps.store()
      const account = await deps.account()
      const target = embeddingTarget(deps, choice)
      const chatId = await storedChatId(deps.messenger, chat, store, account, { includeLeft: true })
      const [source] = await store.conversations.conversationsOfMessages(account, [{ chatId, messageId: message }])
      if (!source) {
        if (!(await store.conversations.conversationState(account, chatId))?.builtAt) throw notBuiltError(deps, chatId)
        throw new CliError("not_found", `message ${message} is in no conversation of chat ${chatId}`)
      }
      const { vectors } = await store.vectors.conversationVectors(account, source.id, target.key)
      if (vectors.length === 0) {
        const [own] = await readinessOf(deps, chatId, target.key)
        const step = own && isStale(own) ? "links rebuild" : "embed"
        throw new CliError(
          "not_found",
          `conversation ${source.id} has no vector of ${target.id} that matches its messages now — ` +
            `\`${command} conversations ${step} --chat ${chatId}\``,
        )
      }
      const hits = await store.vectors.nearestConversations(account, {
        model: target.key,
        limit: Math.max(limit, CANDIDATES),
        query: meanOf(vectors),
        exclude: source.id,
      })
      return {
        model: target.id,
        source,
        hits: hits
          .slice(0, limit)
          .map(({ summary, chunk, score, stale }) => ({ summary, chunk, score, by: ["meaning"], stale })),
        readiness: searchReadiness(await readinessOf(deps, undefined, target.key, true), true, new Set()),
      }
    },
  }
}

/** Reciprocal rank fusion of the two lists: each conversation scores 1 / (k + rank) in every list it is in. */
const fused = (
  meaning: ConversationHit[],
  words: Pick<ConversationHit, "summary" | "chunk">[],
  minimumCosine: number,
): FoundConversation[] => {
  const merged = new Map<string, FoundConversation & { fused: number }>()
  meaning
    .filter(({ score }) => score > minimumCosine)
    .forEach(({ summary, chunk, score, stale, matchedIn }, index) => {
      merged.set(matchedIn ? `${summary.id}#${chunk.firstMessageId}` : summary.id, {
        summary,
        chunk,
        score,
        by: ["meaning"],
        stale,
        ...(matchedIn ? { matchedIn } : {}),
        fused: 1 / (RRF_K + index + 1),
      })
    })
  words.forEach(({ summary, chunk }, index) => {
    const share = 1 / (RRF_K + index + 1)
    const held = merged.get(summary.id)
    if (held) {
      held.fused += share
      held.by.push("words")
    } else merged.set(summary.id, { summary, chunk, score: null, by: ["words"], stale: false, fused: share })
  })
  return [...merged.values()]
    .sort((a, b) => b.fused - a.fused || (b.score ?? -2) - (a.score ?? -2))
    .map(({ fused: _, ...hit }) => hit)
}

/** The chats in readiness by how a meaning search with these vectors could see them, and the word matches outside any. */
const searchReadiness = (chats: ChatReadiness[], meaning: boolean, outside: Set<Id>): SearchReadiness => {
  const built = new Set(chats.filter(({ state }) => state !== "not-built").map(({ chat }) => chat))
  const ids = (keep: (one: ChatReadiness) => boolean) => chats.filter(keep).map(({ chat }) => chat)
  const byMeaning = (one: ChatReadiness) =>
    meaning && built.has(one.chat) && one.state !== "words-only" && one.vectors.chunks > 0
  return {
    searchedByMeaning: ids(byMeaning),
    wordsOnly: ids((one) => built.has(one.chat) && !byMeaning(one)),
    partial: ids((one) => byMeaning(one) && one.vectors.missing > 0),
    stale: ids((one) => built.has(one.chat) && isStale(one)),
    notBuilt: [
      ...new Set([...ids((one) => one.state === "not-built"), ...[...outside].filter((id) => !built.has(id))]),
    ].sort(),
  }
}

/** Unit vectors' mean, made unit length again so the dot product stays a cosine. */
const meanOf = (vectors: Float32Array[]): Float32Array => {
  const mean = new Float32Array(vectors[0]?.length ?? 0)
  for (const vector of vectors) {
    for (let index = 0; index < mean.length; index++) mean[index] = (mean[index] as number) + (vector[index] as number)
  }
  const length = Math.hypot(...mean) || 1
  return mean.map((value) => value / length)
}
