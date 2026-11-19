import { CliError } from "@wirecat/cli-base"
import { formatLocator, parseLocator } from "../domain/locator.js"
import type { Id } from "../domain/models.js"
import { meaningFloor } from "../embeddings/models.js"
import { type FusedFacts, fuseRanked } from "../search/fusion.js"
import { isQueryLimit, QUERY_LIMITS, searchError } from "../search/lucene/types.js"
import { respelled } from "../search/respell.js"
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
import { namedChat, queryWords, without } from "./named-chat.js"
import { MAIL } from "./search-kind.js"
import { refreshSearch } from "./search-refresh.js"

/** How deep each list is read before the two are merged. */
const CANDIDATES = 50
/** Conversations the meaning half reads across chats before it gives each chat its share. */
const ACROSS_CHATS = 500
/** The owner's own chunks shown beside the hits: a result list ranks them low, and a question is often about them. */
const OWN_BLOCK = 5
/**
 * What one chat brings to each list when several are searched, so a large chat cannot fill them. Its meaning hits
 * count by how far they lead its 20th best: a large chat holds some text near any question, and a small chat's
 * clear best must not lose to that.
 */
const PER_CHAT = 20
/** Messages the word search reads: one long thread can hold many of them. */
const WORD_HITS = 200
/** Messages of a hit shown with it, and how much of each: enough to tell the answer, not the whole chunk. */
const SHOWN_LINES = 3
const SHOWN_CHARS = 200
/** Messages of a chunk read to pick the shown ones: a chunk is ~1,200 characters. */
const CHUNK_READ = 60
/** Reciprocal rank fusion's usual constant (phase 5 E9). */
const RRF_K = 60

export const embeddingsSearch = (deps: ServiceDeps): Pick<EmbeddingsService, "search" | "related"> => {
  const command = deps.messenger.app.command

  /**
   * The conversations holding messages that share a word with the query, best message first. Every word
   * is one side of an OR, so a sentence ranks what shares any of it, and nothing in it is read as a filter.
   * Only whole words and their beginnings count, except for a word no message holds at all: that one is read as
   * the words it may stand for (`respelled`), its Latin spelling and the nearest spellings the store holds.
   */
  const byWords = async (
    query: string,
    prepared: Prepared,
    conversations: string[] | undefined,
    since: string | undefined,
    timeLimitMs: number | undefined,
  ) => {
    const words = queryWords(query)
    const outside = new Map<string, { account: AccountKey; chats: Set<Id> }>()
    if (!words.length || !prepared.scopeAccounts.length)
      return { hits: [], outside, sources: new Map<string, AccountKey>(), respellings: new Map<string, string[]>() }
    const store = await deps.store()
    const respellings = await respelled(store.searchIndex, words)
    const lexical = await prepareLucene(
      store,
      await deps.account(),
      {
        text: words
          .flatMap((word) => [word, ...(respellings.get(word) ?? [])])
          .map((word) => (word.length >= 3 ? `${word}*` : `"${word}"`))
          .join(" OR "),
        accounts: prepared.scopeAccounts,
        limit: WORD_HITS,
        ...(timeLimitMs === undefined ? {} : { timeLimitMs }),
      },
      deps.messenger,
    )
    const { items } = await store.queries.matchQuery({
      ...lexical.execution,
      ...(prepared.selectedChat ? {} : { perChat: PER_CHAT }),
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
    type Ranked = { summary: ConversationSummary; chunk: { firstMessageId: Id; lastMessageId: Id } } & FusedFacts
    let ranked: Ranked[] = items.flatMap(({ id, score, timestamp }, index) => {
      const summary = summaries.get(index)
      return summary
        ? [
            {
              summary,
              chunk: { firstMessageId: id, lastMessageId: id },
              ranked: score !== null,
              at: Date.parse(timestamp),
            },
          ]
        : []
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
      const emails: Ranked[] = []
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
          emails.push({
            summary,
            chunk: { firstMessageId: hit.id, lastMessageId: hit.id },
            ranked: hit.score !== null,
            at: Date.parse(hit.timestamp),
          })
        }
      }
      ranked = fuseRanked([ranked, emails], (one) => one)
    }
    const seen = new Set<string>()
    const hits = ranked.flatMap(({ summary, chunk }) => {
      if (seen.has(summary.id)) return []
      seen.add(summary.id)
      return [{ summary, chunk }]
    })
    return { hits, outside, sources, respellings }
  }

  const search: EmbeddingsService["search"] = async (
    query,
    { chat, model: choice, since, limit, filter, source, timezone, syncFirst, signal, refresh, timeLimitMs, reply },
  ) => {
    if (!query.trim()) searchError("query.invalid-syntax", { start: 0, end: query.length }, "give words to search for")
    if (new TextEncoder().encode(query).length > QUERY_LIMITS.bytes)
      searchError("query.too-large", { start: 0, end: query.length }, "query is longer than 8 KiB")
    if (reply !== undefined && new TextEncoder().encode(reply).length > QUERY_LIMITS.bytes)
      throw new CliError("validation_error", "--reply is longer than 8 KiB: one sentence is enough")
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
    // Out of time in words still leaves the meaning half, the one a sentence needs most.
    let wordsOutOfTime = false
    const words = await byWords(query, prepared, eligibility?.conversations, since, timeLimitMs).catch(
      (error: unknown) => {
        if (!isQueryLimit(error)) throw error
        wordsOutOfTime = true
        return {
          hits: [],
          outside: new Map<string, { account: AccountKey; chats: Set<Id> }>(),
          sources: new Map(),
          respellings: new Map<string, string[]>(),
        }
      },
    )
    const texts = reply?.trim() ? [query, reply] : [query]
    const meaning: { hit: ConversationHit; lead: number }[][] = texts.map(() => [])
    const own: ConversationHit[] = []
    const sources = words.sources
    if (target.installed && prepared.scopeAccounts.length && eligibility?.conversations.length !== 0) {
      await withEmbedder(deps, target, choice, {}, async (embedder) => {
        const vectors = await embedder.embed(texts, "query")
        for (const [at, vector] of vectors.entries())
          for (const one of prepared.scopeAccounts) {
            const scope = scopeOf(one)
            if (scope === null) continue
            // One chat needs no share, and mail's threads are too many to share among.
            const whole = "chatId" in scope || one.provider === MAIL
            const hits = await store.vectors.nearestConversations(one, {
              ...scope,
              ...(since === undefined ? {} : { since }),
              model: target.key,
              limit: whole ? Math.max(limit, CANDIDATES) : Math.max(limit, ACROSS_CHATS),
              query: vector as Float32Array,
              ...(eligibility ? { conversations: eligibility.conversations } : {}),
            })
            // The reply only widens the text hits: pictures and the owner's block come from the query alone.
            const images =
              at > 0
                ? []
                : await store.vectors.nearestImages(one, {
                    ...scope,
                    ...(since === undefined ? {} : { since }),
                    model: target.key,
                    limit: Math.max(limit, CANDIDATES),
                    query: vector as Float32Array,
                  })
            const found = [
              ...hits,
              ...images.filter((hit) => !eligibility || eligibility.conversations.includes(hit.summary.id)),
            ].sort((a, b) => b.score - a.score)
            const mine =
              at > 0
                ? []
                : await store.vectors.nearestConversations(one, {
                    ...scope,
                    ...(since === undefined ? {} : { since }),
                    model: target.key,
                    limit: OWN_BLOCK,
                    query: vector as Float32Array,
                    fromOwner: true,
                    ...(eligibility ? { conversations: eligibility.conversations } : {}),
                  })
            for (const hit of found) sources.set(hit.summary.id, one)
            for (const hit of mine) {
              sources.set(hit.summary.id, one)
              own.push(hit)
            }
            meaning[at]?.push(...(whole ? found.map((hit) => ({ hit, lead: hit.score })) : shared(found, limit)))
          }
      })
    }
    for (const list of meaning) list.sort((a, b) => b.lead - a.lead)
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
            prepared.scopeAccounts.length > 1 ? [one.provider, one.account, id].map(encodeURIComponent).join("/") : id,
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
    const located = <T extends Pick<FoundConversation, "summary" | "chunk">>(hit: T) => {
      const source = sources.get(hit.summary.id) as AccountKey
      return {
        ...hit,
        source,
        locator: formatLocator({ ...source, chat: hit.summary.chatId, message: hit.chunk.firstMessageId }),
      }
    }
    const hits = fused(
      meaning.map((list) => list.map(({ hit }) => hit)),
      words.hits,
      meaningFloor(target.key),
    )
      .slice(0, limit)
      .map(located)
    const shown = new Set(hits.map((hit) => hit.summary.id))
    const ownHits = own
      .filter((hit) => !shown.has(hit.summary.id))
      .sort((a, b) => b.score - a.score)
      .slice(0, OWN_BLOCK)
      .map((hit) => located({ ...hit, by: ["meaning" as const] }))
    const stems = wordStems(texts.join(" "))
    const withLines = async <T extends FoundConversation>(hit: T, ownFirst: boolean): Promise<T> => {
      const read = await store.conversations.chunkMessages(hit.source ?? account, hit.summary.id, hit.chunk, CHUNK_READ)
      const lines = shownLines(read, stems, ownFirst)
      return lines.length ? { ...hit, lines } : hit
    }
    return {
      accounts: prepared.scopeAccounts,
      model: target.id,
      meaning: target.installed ? "searched" : "unavailable",
      ...(wordsOutOfTime ? { words: "out-of-time" as const } : {}),
      ...(words.respellings.size ? { respelled: Object.fromEntries(words.respellings) } : {}),
      hits: await Promise.all(hits.map((hit) => withLines(hit, false))),
      ...(ownHits.length ? { own: await Promise.all(ownHits.map((hit) => withLines(hit, true))) } : {}),
      readiness,
      ...(locallyRefreshed ? { prepared: locallyRefreshed } : {}),
      ...(refreshed
        ? { refreshed, coverage: { state: refreshed.complete ? ("partial" as const) : ("stale" as const) } }
        : {}),
      embeddedOnlyElsewhere: elsewhere,
    }
  }

  return {
    /** Over every chat, a query that names someone by a name their private chat uses has that chat's hits first. */
    search: async (query, options) => {
      const found = await search(query, options)
      if (options.chat !== undefined || options.filter !== undefined || found.accounts?.length !== 1) return found
      const named = await namedChat(
        await deps.store(),
        await deps.account(),
        deps.messenger,
        found.accounts,
        queryWords(query),
      ).catch((error: unknown) => {
        if (isQueryLimit(error)) return undefined
        throw error
      })
      if (!named) return found
      // Inside the chat the name is in every other message, so it would only add noise there.
      const rest = without(query, named.word)
      const { syncFirst: _, refresh: __, ...plain } = options
      const inside = await search(rest || query, { ...plain, chat: named.chatId })
      const shown = new Set(inside.hits.map(({ summary }) => summary.id))
      return {
        ...found,
        named: { word: named.word, chatId: named.chatId, title: named.title },
        hits: [...inside.hits, ...found.hits.filter(({ summary }) => !shown.has(summary.id))].slice(0, options.limit),
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

/**
 * Each chat's best hits, as many as the page holds, with each one's lead over the chat's `PER_CHAT`th best (or its
 * last, in a chat with fewer).
 */
const shared = (hits: ConversationHit[], limit: number) => {
  const chats = new Map<Id, ConversationHit[]>()
  for (const hit of hits) chats.set(hit.summary.chatId, [...(chats.get(hit.summary.chatId) ?? []), hit])
  return [...chats.values()].flatMap((own) => {
    const level = own[Math.min(PER_CHAT, own.length) - 1]?.score ?? 0
    return own.slice(0, Math.max(limit, PER_CHAT)).map((hit) => ({ hit, lead: hit.score - level }))
  })
}

/**
 * Reciprocal rank fusion of the meaning lists (the query's, and a made-up reply's when given) and the word list: each
 * conversation scores 1 / (k + rank) in every list it is in, and keeps the chunk and cosine of the first list that
 * has it, so a score shown is the query's wherever the query found it.
 */
const fused = (
  meaning: ConversationHit[][],
  words: Pick<ConversationHit, "summary" | "chunk">[],
  minimumCosine: number,
): FoundConversation[] => {
  const merged = new Map<string, FoundConversation & { fused: number }>()
  for (const list of meaning)
    list
      .filter(({ score }) => score > minimumCosine)
      .forEach(({ summary, chunk, score, stale, matchedIn }, index) => {
        const key = matchedIn ? `${summary.id}#${chunk.firstMessageId}` : summary.id
        const share = 1 / (RRF_K + index + 1)
        const held = merged.get(key)
        if (!held) {
          merged.set(key, {
            summary,
            chunk,
            score,
            by: ["meaning"],
            stale,
            ...(matchedIn ? { matchedIn } : {}),
            fused: share,
          })
          return
        }
        held.fused += share
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

/** Each word's first five letters, lowercased: enough to match its other forms in Russian and English. */
const wordStems = (text: string) => [...new Set(queryWords(text).map((word) => word.slice(0, 5)))]

/**
 * The messages that share most of `stems`, at most `SHOWN_LINES`, oldest first, each cut to `SHOWN_CHARS` around
 * its first match. With `ownFirst` the owner's own messages come first: the owner block is there for them.
 */
const shownLines = (
  read: { sender: string | null; text: string; outgoing: boolean }[],
  stems: string[],
  ownFirst: boolean,
) => {
  const scored = read.map(({ text, ...line }, at) => {
    const flat = text.replace(/\s+/g, " ").trim()
    const lower = flat.toLowerCase()
    const found = stems.filter((stem) => lower.includes(stem))
    const first = found.reduce((least, stem) => Math.min(least, lower.indexOf(stem)), Number.POSITIVE_INFINITY)
    return { ...line, flat, at, score: found.length + (ownFirst && line.outgoing ? 100 : 0), first }
  })
  return [...scored]
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, SHOWN_LINES)
    .sort((a, b) => a.at - b.at)
    .map(({ sender, flat, outgoing, first }) => {
      const start =
        Number.isFinite(first) && first > SHOWN_CHARS / 2
          ? Math.max(0, Math.min(first - SHOWN_CHARS / 4, flat.length - SHOWN_CHARS))
          : 0
      const cut = flat.slice(start, start + SHOWN_CHARS)
      const who = outgoing ? `${sender ?? "you"}${sender ? " (you)" : ""}: ` : sender ? `${sender}: ` : ""
      return `${who}${start > 0 ? "…" : ""}${cut}${start + SHOWN_CHARS < flat.length ? "…" : ""}`
    })
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
