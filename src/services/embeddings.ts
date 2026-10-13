import { CliError } from "@wirecat/cli-base"
import { CHUNK_CHARS, chunkHash, chunkTextOf } from "../conversations/chunks.js"
import { RULES_VERSION } from "../conversations/link.js"
import { formatLocator, parseLocator } from "../domain/locator.js"
import type { Id } from "../domain/models.js"
import { defaultThreads, type Embedder, isTextModelInstalled, textModelsDirectory } from "../embeddings/embed.js"
import { DEFAULT_TEXT_MODEL, meaningFloor, type TextModel, textModel } from "../embeddings/models.js"
import { type RemoteModel, remoteKey } from "../embeddings/remote.js"
import { QUERY_LIMITS, searchError } from "../search/lucene/types.js"
import {
  type AccountKey,
  type ConversationHit,
  type ConversationSummary,
  type StoredReadiness,
  threadConversation,
} from "../store/store.js"
import { type Built, conversationsService } from "./conversations.js"
import type { ServiceDeps } from "./deps.js"
import { storedChatId } from "./messages.js"
import { type Prepared, prepareLucene } from "./messages-search.js"
import { MAIL } from "./search-kind.js"
import { refreshSearch, type SearchRefreshed, type SyncOptions } from "./search-refresh.js"

/** A local model by id (the default when nothing is given), or a remote one with the user's key (E11). */
export type ModelChoice = string | { remote: RemoteModel; apiKey?: string; concurrency?: number }

export interface EmbedStatus {
  chat: Id
  model: string
  /** The current build's distinct chunk texts. */
  chunks: number
  embedded: number
  left: number
  /** A local model at its measured speed on one session; `null` for a remote one. */
  estimateSeconds: number | null
  /** At most this many tokens are sent for what is left — a chunk is at most `CHUNK_CHARS` characters. */
  tokensAtMost: number
  /** For a remote model with a known price: at most this many US dollars for what is left. */
  priceAtMost?: { usd: number; read: string }
}

export interface Embedded {
  chat: Id
  model: string
  embedded: number
  /** Chunks whose messages changed since the build: `conversations build` cuts them again. */
  skipped: number
}

export interface EmbeddingsService {
  status(chat: string, model?: ModelChoice): Promise<EmbedStatus>
  /** Embeds every chunk of the chat's current build that has no vector of the model, a batch at a time. */
  embed(
    chat: string,
    options: {
      model?: ModelChoice
      workers?: number
      threads?: number
      /** Stops after this many chunks; the next run resumes. */
      maxChunks?: number
      progress?: (done: number, left: number) => void
    },
  ): Promise<Embedded>
  /** Drops the chat's vectors, or one model's; messages and conversations are never touched. */
  clear(chat: string, model?: ModelChoice): Promise<{ chat: Id; cleared: number }>
  /**
   * The conversations nearest in meaning to `query`, in one chat or every one of the account (E7). With no
   * local model downloaded it answers by words alone (NEED-552 A): never a download, never a remote model.
   */
  search(
    query: string,
    options: {
      chat?: string
      model?: ModelChoice
      since?: string
      limit: number
      filter?: string
      source?: string
      timezone?: string
      syncFirst?: SyncOptions
      signal?: AbortSignal
      /** Local graph catch-up after any network refresh and before searching. */
      refresh?: RefreshOptions
    },
  ): Promise<FoundConversations>
  /**
   * The conversations of every built chat nearest in meaning to the one `message` is in, best first, never that
   * one: the mean of its current vectors is the query, so no model runs and none need be downloaded.
   */
  related(chat: string, message: Id, options: { model?: ModelChoice; limit: number }): Promise<RelatedConversations>
  /**
   * How fresh one chat's conversations and vectors are, or every built chat's — and then how many group chats
   * were never built, which `conversations build` would also do.
   */
  readiness(options: {
    chat?: string
    model?: ModelChoice
  }): Promise<{ model: string; chats: ChatReadiness[]; unbuiltGroups?: number }>
  /**
   * Builds and embeds, on this machine, the chats that changed or were never built — one chat, or every built
   * chat and every group chat never built — within the bounds (NEED-551 A). Never downloads a model.
   */
  refresh(options: RefreshOptions): Promise<Refreshed>
}

export interface RefreshOptions {
  maxMessages?: number
  check?: () => void
  chat?: string
  /** A local model id; a remote model is only ever chosen per chat, with the owner's yes. */
  model?: string
  build?: boolean
  embed?: boolean
  maxChats?: number
  maxChunks?: number
  workers?: number
  threads?: number
  progress?: (note: string) => void
}

export interface Refreshed {
  model: string
  /** `false`: the model is not downloaded, so nothing was embedded. */
  modelAvailable: boolean
  built: Built[]
  embedded: Embedded[]
  /** Chats still needing a build or vectors after this run: over a bound, or the model is missing. */
  left: { chat: Id; needs: "build" | "embed" }[]
}

/** How much one run without `--chat` does at most, by default. */
export const REFRESH_BOUNDS = { maxChats: 20, maxChunks: 2_000 }

export interface FoundConversations {
  accounts?: AccountKey[]
  prepared?: Refreshed
  refreshed?: SearchRefreshed
  coverage?: { state: "partial" | "stale" }
  model: string
  /** `unavailable`: the local model is not downloaded, and only words were searched. */
  meaning: "searched" | "unavailable"
  hits: FoundConversation[]
  readiness: SearchReadiness
  /** Kept for callers of 0.141.0 and before; `readiness.wordsOnly` says more. */
  embeddedOnlyElsewhere: Id[]
}

export interface RelatedConversations {
  model: string
  /** The conversation the message is in. */
  source: ConversationSummary
  hits: FoundConversation[]
  readiness: SearchReadiness
}

/** Chat ids by how the search could see them; a chat can be in more than one list. */
export interface SearchReadiness {
  scopes?: { source: AccountKey; readiness: SearchReadiness }[]
  /** Built chats with vectors of the model. */
  searchedByMeaning: Id[]
  /** Built chats with no vector of the model, or every built chat when the model is unavailable. */
  wordsOnly: Id[]
  /** Searched by meaning, but some chunks have no vector yet: `conversations embed`. */
  partial: Id[]
  /** Messages or rules changed since the build: `conversations build`. */
  stale: Id[]
  /** Never built, so their matches cannot be shown: `conversations build`. */
  notBuilt: Id[]
}

export type ReadinessState = "ready" | "stale" | "partial" | "words-only" | "not-built"

export interface ChatReadiness {
  chat: Id
  state: ReadinessState
  graph: { builtAt: string; rulesVersion: number | null; outdatedRules: boolean } | null
  pending: { new: number; edited: number; deleted: number }
  /** The current build's distinct chunk texts, by their vector of the model: `current` + `stale` + `missing`. */
  vectors: { chunks: number; current: number; stale: number; missing: number }
}

/** A conversation found by meaning, by words, or both (E9). */
export interface FoundConversation {
  source?: AccountKey
  locator?: string
  summary: ConversationSummary
  /** The chunk nearest in meaning; the best message found by words when only words found it. */
  chunk: { firstMessageId: Id; lastMessageId: Id }
  /** The best chunk's cosine, −1 to 1; `null` when only words found it. */
  score: number | null
  by: ("meaning" | "words")[]
  /** The chunk's text changed after it was embedded: the score is for what it said then (NEED-550 B). */
  stale: boolean
}

/** A vector's model: the provider, the model and its size — vectors of two of them never mix. */
export const vectorModelKey = (model: TextModel): string => `local:${model.id}:${model.dims}`

/** Chunks per batch for one local session; one short transaction writes each batch. */
const PER_SESSION = 8
/** Texts per remote request; `concurrency` of them run at once. */
const PER_REQUEST = 256
/** How deep each list is read before the two are merged. */
const CANDIDATES = 50
/** Messages the word search reads: one long thread can hold many of them. */
const WORD_HITS = 200
/** Reciprocal rank fusion's usual constant (phase 5 E9). */
const RRF_K = 60
/** e5's tokenizer reads ~3.7 characters a token in Russian; 3 keeps the bound above the real count. */
const CHARS_PER_TOKEN_AT_LEAST = 3

export const embeddingsService = (deps: ServiceDeps): EmbeddingsService => {
  const command = deps.messenger.app.command

  const notDownloaded = (id: string) =>
    new CliError("not_found", `${id} is not downloaded — \`${command} models text download ${id}\``)

  const notBuiltError = (chatId: Id) =>
    new CliError(
      "not_found",
      `chat ${chatId} has no conversations yet — \`${command} conversations build --chat ${chatId}\``,
    )

  const resolve = (choice: ModelChoice = DEFAULT_TEXT_MODEL) => {
    if (typeof choice !== "string") {
      const { remote, apiKey, concurrency = 4 } = choice
      return {
        id: `${remote.provider}:${remote.model}`,
        key: remoteKey(remote),
        dims: remote.dims,
        speed: null,
        price: remote.price,
        installed: true,
        perBatch: (_workers: number) => PER_REQUEST * concurrency,
        open: async (): Promise<Embedder> =>
          (await import("../embeddings/remote.js")).openRemote(remote, apiKey, { concurrency }),
      }
    }
    const model = textModel(choice)
    const directory = textModelsDirectory(deps.env)
    return {
      id: model.id,
      key: vectorModelKey(model),
      dims: model.dims,
      speed: model.chunksPerSecond,
      price: undefined,
      installed: isTextModelInstalled(model, directory),
      perBatch: (workers: number) => PER_SESSION * Math.max(1, workers),
      open: async ({
        workers = 1,
        threads,
        apart = false,
      }: {
        workers?: number
        threads?: number
        /** In a process of its own, which gives all of its memory back when closed: the MCP server's. */
        apart?: boolean
      } = {}): Promise<Embedder> => {
        if (!isTextModelInstalled(model, directory)) throw notDownloaded(model.id)
        if (apart) {
          const { openProcess } = await import("../embeddings/process.js")
          return openProcess(model, directory, { threads: threads ?? defaultThreads() })
        }
        const { openPool } = await import("../embeddings/pool.js")
        return openPool(model, directory, { workers, ...(threads ? { threads } : {}) })
      },
    }
  }

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
    if (!store.matchQuery) throw new CliError("validation_error", "the store does not support strict search")
    const { items } = await store.matchQuery({
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
      const found = await store.conversationsOfMessages(
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
      const mail = await store
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
        const { id } = await store.storedAccount(account)
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

  const readinessOf = async (chatId: Id | undefined, key: string): Promise<ChatReadiness[]> => {
    const store = await deps.store()
    const account = await deps.account()
    return (await store.readiness(account, { ...(chatId === undefined ? {} : { chatId }), model: key })).map(shaped)
  }

  const found = async (chat: string) => {
    const store = await deps.store()
    const account = await deps.account()
    const chatId = await storedChatId(deps.messenger, chat, store, account)
    if (!(await store.conversationState(account, chatId))?.builtAt) throw notBuiltError(chatId)
    return { store, account, chatId }
  }

  type Target = ReturnType<typeof resolve>

  /** The server's warm model when there is one, kept open after; otherwise opened here and closed. */
  const withEmbedder = async <T>(
    target: Target,
    choice: ModelChoice | undefined,
    { workers = 1, threads }: { workers?: number; threads?: number | undefined },
    work: (embedder: Embedder) => Promise<T>,
  ): Promise<T> => {
    const warm = typeof choice !== "object" ? deps.embedders : undefined
    const embedder = warm
      ? await warm.get(target.key, () => target.open({ apart: true }))
      : await target.open({ workers, ...(threads ? { threads } : {}) })
    try {
      return await work(embedder)
    } finally {
      if (!warm) await embedder.close()
    }
  }

  const embedInto = async (
    chatId: Id,
    target: Target,
    embedder: Embedder,
    {
      workers = 1,
      maxChunks = Number.POSITIVE_INFINITY,
      progress,
      check,
    }: {
      workers?: number | undefined
      maxChunks?: number | undefined
      check?: () => void
      progress?: ((done: number, left: number) => void) | undefined
    },
  ): Promise<Embedded> => {
    const store = await deps.store()
    const account = await deps.account()
    let embedded = 0
    let skipped = 0
    let left = (await store.vectorStatus(account, chatId, target.key)).chunks
    let after: string | undefined
    while (embedded + skipped < maxChunks) {
      check?.()
      const batch = await store.chunksToEmbed(account, chatId, target.key, {
        limit: Math.min(target.perBatch(workers), maxChunks - embedded - skipped),
        ...(after ? { after } : {}),
      })
      if (batch.length === 0) break
      after = batch.at(-1)?.hash
      const ready = batch.flatMap(({ hash, lines }) => {
        const text = chunkTextOf(lines)
        return chunkHash(text) === hash ? [{ hash, text }] : []
      })
      skipped += batch.length - ready.length
      const vectors = await embedder.embed(
        ready.map(({ text }) => text),
        "passage",
      )
      check?.()
      await store.saveVectors(
        target.key,
        target.dims,
        ready.map(({ hash }, index) => ({ hash, vector: vectors[index] as Float32Array })),
      )
      embedded += ready.length
      left = Math.max(0, left - batch.length)
      progress?.(embedded, left)
    }
    return { chat: chatId, model: target.id, embedded, skipped }
  }

  return {
    status: async (chat, choice) => {
      const { store, account, chatId } = await found(chat)
      const target = resolve(choice)
      const { chunks, embedded } = await store.vectorStatus(account, chatId, target.key)
      const left = chunks - embedded
      const tokensAtMost = Math.ceil((left * CHUNK_CHARS) / CHARS_PER_TOKEN_AT_LEAST)
      return {
        chat: chatId,
        model: target.id,
        chunks,
        embedded,
        left,
        estimateSeconds: target.speed === null ? null : Math.ceil(left / target.speed),
        tokensAtMost,
        ...(target.price
          ? { priceAtMost: { usd: (tokensAtMost / 1e6) * target.price.perMillion, read: target.price.read } }
          : {}),
      }
    },

    embed: async (chat, { model: choice, workers = 1, threads, maxChunks, progress }) => {
      const { chatId } = await found(chat)
      const target = resolve(choice)
      return withEmbedder(target, choice, { workers, threads }, (embedder) =>
        embedInto(chatId, target, embedder, { workers, maxChunks, progress }),
      )
    },

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
        language: "lucene",
        text: filter,
        source,
        timezone,
      })
      const locallyRefreshed = refresh ? await embeddingsService(deps).refresh(refresh) : undefined
      const store = await deps.store()
      const account = await deps.account()
      const target = resolve(choice)
      const stop = Date.now() + 200
      await store.fillSearchIndex({ until: () => Date.now() >= stop })
      await store.fillStems({ until: () => Date.now() >= stop })
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
      if (filter !== undefined && !store.conversationEligibility)
        throw new CliError("validation_error", "the store does not support conversation filters — upgrade cli-core")
      const eligibility = filter === undefined ? undefined : await store.conversationEligibility?.(prepared.execution)
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
        await withEmbedder(target, choice, {}, async (embedder) => {
          const [vector] = await embedder.embed([query], "query")
          for (const one of prepared.scopeAccounts) {
            const scope = scopeOf(one)
            if (scope === null) continue
            const hits = await store.nearestConversations(one, {
              ...scope,
              ...(since === undefined ? {} : { since }),
              model: target.key,
              limit: Math.max(limit, CANDIDATES),
              query: vector as Float32Array,
              ...(eligibility ? { conversations: eligibility.conversations } : {}),
            })
            for (const hit of hits) sources.set(hit.summary.id, one)
            meaning.push(...hits)
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
            ? await store.readiness(one, { ...scope, model: target.key })
            : (
                await Promise.all(eligibleChats.map((chatId) => store.readiness(one, { chatId, model: target.key })))
              ).flat()
        const readiness = searchReadiness(
          rows.map(shaped),
          target.installed,
          words.outside.get(JSON.stringify(one))?.chats ?? new Set(),
        )
        scoped.push({ source: one, readiness })
        const other = await store.embeddedOnlyElsewhere(one, { ...scope, model: target.key })
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
      const target = resolve(choice)
      const chatId = await storedChatId(deps.messenger, chat, store, account)
      const [source] = await store.conversationsOfMessages(account, [{ chatId, messageId: message }])
      if (!source) {
        if (!(await store.conversationState(account, chatId))?.builtAt) throw notBuiltError(chatId)
        throw new CliError("not_found", `message ${message} is in no conversation of chat ${chatId}`)
      }
      const { vectors } = await store.conversationVectors(account, source.id, target.key)
      if (vectors.length === 0) {
        const [own] = await readinessOf(chatId, target.key)
        const step = own && isStale(own) ? "build" : "embed"
        throw new CliError(
          "not_found",
          `conversation ${source.id} has no vector of ${target.id} that matches its messages now — ` +
            `\`${command} conversations ${step} --chat ${chatId}\``,
        )
      }
      const hits = await store.nearestConversations(account, {
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
        readiness: searchReadiness(await readinessOf(undefined, target.key), true, new Set()),
      }
    },

    readiness: async ({ chat, model: choice }) => {
      const store = await deps.store()
      const account = await deps.account()
      const target = resolve(choice)
      const chatId = chat === undefined ? undefined : await storedChatId(deps.messenger, chat, store, account)
      const chats = await readinessOf(chatId, target.key)
      if (chatId !== undefined) return { model: target.id, chats }
      return { model: target.id, chats, unbuiltGroups: (await store.unbuiltGroups(account)).length }
    },

    refresh: async ({
      chat,
      model: choice = DEFAULT_TEXT_MODEL,
      build = true,
      embed = true,
      maxChats = REFRESH_BOUNDS.maxChats,
      maxChunks = REFRESH_BOUNDS.maxChunks,
      workers,
      threads,
      progress,
      maxMessages,
      check,
    }) => {
      check?.()
      const store = await deps.store()
      const account = await deps.account()
      const target = resolve(choice)
      if (embed && !build && !target.installed) throw notDownloaded(target.id)
      const chatId = chat === undefined ? undefined : await storedChatId(deps.messenger, chat, store, account)
      const scan = async () => ({
        chats: (await readinessOf(chatId, target.key)).sort(byOldestBuild),
        unbuilt: chatId === undefined ? await store.unbuiltGroups(account) : [],
      })

      const built: Built[] = []
      if (build) {
        const { chats, unbuilt } = await scan()
        const queue = [...chats.filter(needsBuild).map(({ chat }) => chat), ...unbuilt].slice(0, maxChats)
        const conversations = conversationsService(deps)
        for (const id of queue) {
          try {
            check?.()
            const one = await conversations.build(id, { maxMessages, check })
            built.push(one)
            progress?.(`chat ${id}: ${one.messages} messages → ${one.conversations} conversations`)
          } catch (error) {
            // Every message of a once-built chat deleted: nothing to build, and it stays in `left`.
            if (!(error instanceof CliError && error.code === "not_found")) throw error
          }
        }
      }

      const embedded: Embedded[] = []
      if (embed && target.installed) {
        const fresh = new Set(built.map(({ chat }) => chat))
        const queue = (await scan()).chats
          .filter(needsEmbed)
          .sort((a, b) => Number(fresh.has(b.chat)) - Number(fresh.has(a.chat)))
          .slice(0, maxChats)
        if (queue.length > 0) {
          await withEmbedder(target, choice, { workers, threads }, async (embedder) => {
            let budget = maxChunks
            for (const { chat } of queue) {
              if (budget <= 0) break
              check?.()
              const done = await embedInto(chat, target, embedder, { workers, maxChunks: budget, check })
              budget -= done.embedded + done.skipped
              embedded.push(done)
              progress?.(`chat ${chat}: ${done.embedded} chunks embedded with ${target.id}`)
            }
          })
        }
      }

      const after = await scan()
      const rebuild = build ? [...after.chats.filter(needsBuild).map(({ chat }) => chat), ...after.unbuilt] : []
      const pending = new Set(rebuild)
      return {
        model: target.id,
        modelAvailable: target.installed,
        built,
        embedded,
        left: [
          ...rebuild.map((chat) => ({ chat, needs: "build" as const })),
          ...(embed
            ? after.chats
                .filter((one) => needsEmbed(one) && !pending.has(one.chat))
                .map(({ chat }) => ({ chat, needs: "embed" as const }))
            : []),
        ],
      }
    },

    clear: async (chat, choice) => {
      const store = await deps.store()
      const account = await deps.account()
      const chatId = await storedChatId(deps.messenger, chat, store, account)
      const cleared = await store.clearVectors(account, chatId, choice === undefined ? undefined : resolve(choice).key)
      return { chat: chatId, cleared }
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
    .forEach(({ summary, chunk, score, stale }, index) => {
      merged.set(summary.id, { summary, chunk, score, by: ["meaning"], stale, fused: 1 / (RRF_K + index + 1) })
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

const needsBuild = (one: ChatReadiness) => one.graph === null || isStale(one)

const needsEmbed = (one: ChatReadiness) => one.graph !== null && one.vectors.missing > 0

/** Never finished first, then the oldest build: the longest-waiting change goes first. */
const byOldestBuild = (a: ChatReadiness, b: ChatReadiness) =>
  (a.graph?.builtAt ?? "").localeCompare(b.graph?.builtAt ?? "")

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

const isStale = ({ graph, pending, vectors }: ChatReadiness) =>
  Boolean(graph?.outdatedRules) || pending.new + pending.edited + pending.deleted > 0 || vectors.stale > 0

const shaped = ({ chatId, builtAt, algorithmVersion, pending, vectors }: StoredReadiness): ChatReadiness => {
  const { embedded, ...counts } = vectors
  const graph =
    builtAt === null
      ? null
      : { builtAt, rulesVersion: algorithmVersion, outdatedRules: algorithmVersion !== RULES_VERSION }
  const one: ChatReadiness = { chat: chatId, state: "ready", graph, pending, vectors: counts }
  const state: ReadinessState =
    graph === null
      ? "not-built"
      : counts.chunks > 0 && embedded === 0
        ? "words-only"
        : isStale(one)
          ? "stale"
          : counts.missing > 0
            ? "partial"
            : "ready"
  return { ...one, state }
}
