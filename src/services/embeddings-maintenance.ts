import { CliError } from "@wirecat/cli-base"
import { CHUNK_CHARS, chunkHash, chunkTextOf } from "../conversations/chunks.js"
import { RULES_VERSION } from "../conversations/link.js"
import type { Id } from "../domain/models.js"
import {
  defaultThreads,
  type Embedder,
  isTextModelInstalled,
  openEmbedder,
  textModelsDirectory,
} from "../embeddings/embed.js"
import { DEFAULT_TEXT_MODEL, textModel, vectorModelKey } from "../embeddings/models.js"
import { remoteKey } from "../embeddings/remote.js"
import { CONTEXT_MESSAGES, CONTEXT_MINUTES } from "../images/context/index.js"
import { registeredImageProviders } from "../images/registry.js"
import { typedCommand } from "../runs/scope.js"
import type { StoredReadiness } from "../store/store.js"
import { type Built, conversationsService } from "./conversations.js"
import type { ServiceDeps } from "./deps.js"
import type { ChatReadiness, Embedded, EmbeddingsService, ModelChoice, ReadinessState } from "./embeddings.js"
import { storedChatId } from "./message-resolution.js"

/** How much one run without `--chat` does at most, by default. */
export const REFRESH_BOUNDS = { maxChats: 20, maxChunks: 2_000 }

/** Messages read per page while looking for those without a current vector. */
const MESSAGE_PAGE = 5_000

interface MessageVector {
  messagePk: number
  text: string
  hash: string
  occurredAt: number
}

/** Chunks per batch for one local session; one short transaction writes each batch. */
const PER_SESSION = 8
/** Texts per remote request; `concurrency` of them run at once. */
const PER_REQUEST = 256
/** e5's tokenizer reads ~3.7 characters a token in Russian; 3 keeps the bound above the real count. */
const CHARS_PER_TOKEN_AT_LEAST = 3

/** Enough of the deps to find a local model and name the command that downloads it. */
export type ModelDeps = Pick<ServiceDeps, "env" | "embedders"> & { messenger: { app: { command: string } } }

/** The download is the error's `next` step, named only by a CLI that has `models` (`failureSteps`). */
const notDownloaded = (id: string) =>
  new CliError("not_found", `${id} is not downloaded on this machine`, { reason: "model.not-downloaded", model: id })

export const notBuiltError = (deps: ServiceDeps, chatId: Id) =>
  new CliError(
    "not_found",
    `chat ${chatId} has no conversations yet — \`${typedCommand(deps.messenger.app.command, `conversations links rebuild --chat ${chatId}`)}\``,
  )

export const embeddingTarget = (deps: ModelDeps, choice: ModelChoice = DEFAULT_TEXT_MODEL) => {
  if (typeof choice !== "string") {
    const { remote, apiKey, concurrency = 4 } = choice
    return {
      id: `${remote.provider}:${remote.model}`,
      key: remoteKey(remote),
      dims: remote.dims,
      speed: null,
      price: remote.price,
      installed: true,
      perBatch: PER_REQUEST * concurrency,
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
    perBatch: PER_SESSION,
    open: async ({
      threads,
      apart = false,
    }: {
      threads?: number
      /** In a process of its own, which gives all of its memory back when closed: the MCP server's. */
      apart?: boolean
    } = {}): Promise<Embedder> => {
      if (!isTextModelInstalled(model, directory)) throw notDownloaded(model.id)
      if (apart) {
        const { openProcess } = await import("../embeddings/process.js")
        return openProcess(model, directory, { threads: threads ?? defaultThreads() })
      }
      return openEmbedder(model, directory, { threads: threads ?? defaultThreads() })
    },
  }
}

export const readinessOf = async (
  deps: ServiceDeps,
  chatId: Id | undefined,
  key: string,
  searchableOnly = false,
): Promise<ChatReadiness[]> => {
  const store = await deps.store()
  const account = await deps.account()
  return (
    await store.vectors.readiness(account, { ...(chatId === undefined ? {} : { chatId }), model: key, searchableOnly })
  ).map(shaped)
}

type EmbeddingTarget = ReturnType<typeof embeddingTarget>

/** The server's warm model when there is one, kept open after; otherwise opened here and closed. */
export const withEmbedder = async <T>(
  deps: ModelDeps,
  target: EmbeddingTarget,
  choice: ModelChoice | undefined,
  { threads }: { threads?: number | undefined },
  work: (embedder: Embedder) => Promise<T>,
): Promise<T> => {
  const warm = typeof choice !== "object" ? deps.embedders : undefined
  const embedder = warm
    ? await warm.get(target.key, () => target.open({ apart: true }))
    : await target.open(threads ? { threads } : {})
  try {
    return await work(embedder)
  } finally {
    if (!warm) await embedder.close()
  }
}

export const embeddingsMaintenance = (
  deps: ServiceDeps,
): Pick<EmbeddingsService, "status" | "embed" | "readiness" | "refresh" | "clear"> => {
  const found = async (chat: string) => {
    const store = await deps.store()
    const account = await deps.account()
    const chatId = await storedChatId(deps.messenger, chat, store, account, { includeLeft: true })
    if (!(await store.conversations.conversationState(account, chatId))?.builtAt) throw notBuiltError(deps, chatId)
    return { store, account, chatId }
  }

  const embedInto = async (
    chatId: Id,
    target: EmbeddingTarget,
    embedder: Embedder,
    {
      maxChunks = Number.POSITIVE_INFINITY,
      progress,
      check,
    }: {
      maxChunks?: number | undefined
      check?: () => void
      progress?: ((done: number, left: number) => void) | undefined
    },
  ): Promise<Embedded> => {
    const store = await deps.store()
    const account = await deps.account()
    let embedded = 0
    let skipped = 0
    let left = (await store.vectors.vectorStatus(account, chatId, target.key)).chunks
    let after: string | undefined
    while (embedded + skipped < maxChunks) {
      check?.()
      const batch = await store.vectors.chunksToEmbed(account, chatId, target.key, {
        limit: Math.min(target.perBatch, maxChunks - embedded - skipped),
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
      await store.vectors.saveVectors(
        target.key,
        target.dims,
        ready.map(({ hash }, index) => ({ hash, vector: vectors[index] as Float32Array })),
      )
      embedded += ready.length
      left = Math.max(0, left - batch.length)
      progress?.(embedded, left)
    }
    embedded += await embedImages(chatId, target, embedder, check)
    return { chat: chatId, model: target.id, embedded, skipped }
  }

  /**
   * One chunk per image of the chat: the text its first image provider gives it, embedded like a message. The
   * chunk's hash names the provider and its version, so a newer provider describes every image again.
   */
  const embedImages = async (
    chatId: Id,
    target: EmbeddingTarget,
    embedder: Embedder,
    check: (() => void) | undefined,
  ): Promise<number> => {
    const providers = registeredImageProviders()
    if (providers.length === 0) return 0
    const store = await deps.store()
    const account = await deps.account()
    const images = await store.vectors.imagesToDescribe(account, chatId, {
      messages: CONTEXT_MESSAGES,
      withinMs: CONTEXT_MINUTES * 60_000,
    })
    const described: { attachmentPk: number; hash: string; text: string; occurredAt: number }[] = []
    for (const image of images) {
      check?.()
      for (const provider of providers) {
        const { text } = await provider.describe(
          { kind: image.kind, name: image.name, mime: image.mime, localPath: image.localPath },
          {
            chatTitle: image.chatTitle,
            sender: image.sender,
            caption: image.caption,
            sentAt: image.sentAt,
            before: image.before,
            after: image.after,
          },
        )
        if (text?.trim()) {
          described.push({
            attachmentPk: image.attachmentPk,
            hash: chunkHash(`${provider.id}:${provider.version}\n${text}`),
            text,
            occurredAt: image.sentAt,
          })
          break
        }
      }
    }
    const have = await store.vectors.embeddedHashes(
      target.key,
      described.map(({ hash }) => hash),
    )
    const missing = [...new Map(described.filter(({ hash }) => !have.has(hash)).map((one) => [one.hash, one])).values()]
    for (let at = 0; at < missing.length; at += PER_REQUEST) {
      const batch = missing.slice(at, at + PER_REQUEST)
      const vectors = await embedder.embed(
        batch.map(({ text }) => text),
        "passage",
      )
      check?.()
      await store.vectors.saveVectors(
        target.key,
        target.dims,
        batch.map(({ hash }, index) => ({ hash, vector: vectors[index] as Float32Array })),
      )
    }
    await store.vectors.saveImageChunks(
      account,
      chatId,
      described.map(({ attachmentPk, hash, text, occurredAt }) => ({
        attachmentPk,
        hash,
        length: text.length,
        occurredAt,
      })),
      described.map(({ attachmentPk }) => attachmentPk),
    )
    return missing.length
  }

  /**
   * The messages of the account, or of one chat, whose own vector is missing or older than their text: at most
   * `budget` of them in hand, and how many more there are. Gone messages lose their chunks first.
   */
  const messagesToEmbed = async (chatId: Id | undefined, model: string, budget: number, check?: () => void) => {
    const store = await deps.store()
    const account = await deps.account()
    await store.vectors.dropGoneMessages(account)
    const items: MessageVector[] = []
    let beyond = 0
    let after = 0
    for (;;) {
      check?.()
      const page = await store.vectors.messagesToEmbed(account, {
        ...(chatId === undefined ? {} : { chatId }),
        model,
        after,
        limit: MESSAGE_PAGE,
      })
      const last = page.at(-1)
      if (!last) break
      after = last.messagePk
      for (const { messagePk, text, sentAt, hash: held, embedded } of page) {
        const hash = chunkHash(text)
        if (hash === held && embedded) continue
        if (items.length < budget) items.push({ messagePk, text, hash, occurredAt: sentAt })
        else beyond++
      }
    }
    return { items, beyond }
  }

  const embedMessages = async (
    items: MessageVector[],
    target: EmbeddingTarget,
    embedder: Embedder,
    check: (() => void) | undefined,
  ): Promise<number> => {
    const store = await deps.store()
    const account = await deps.account()
    for (let at = 0; at < items.length; at += target.perBatch) {
      check?.()
      const batch = items.slice(at, at + target.perBatch)
      const vectors = await embedder.embed(
        batch.map(({ text }) => text),
        "passage",
      )
      await store.vectors.saveMessageVectors(
        account,
        target.key,
        target.dims,
        batch.map(({ messagePk, hash, text, occurredAt }, index) => ({
          messagePk,
          hash,
          length: text.length,
          occurredAt,
          vector: vectors[index] as Float32Array,
        })),
      )
    }
    return items.length
  }

  return {
    status: async (chat, choice) => {
      const { store, account, chatId } = await found(chat)
      const target = embeddingTarget(deps, choice)
      const { chunks, embedded } = await store.vectors.vectorStatus(account, chatId, target.key)
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

    embed: async (chat, { model: choice, threads, maxChunks, progress }) => {
      const { chatId } = await found(chat)
      const target = embeddingTarget(deps, choice)
      return withEmbedder(deps, target, choice, { threads }, (embedder) =>
        embedInto(chatId, target, embedder, { maxChunks, progress }),
      )
    },

    readiness: async ({ chat, model: choice }) => {
      const store = await deps.store()
      const account = await deps.account()
      const target = embeddingTarget(deps, choice)
      const chatId =
        chat === undefined ? undefined : await storedChatId(deps.messenger, chat, store, account, { includeLeft: true })
      const chats = await readinessOf(deps, chatId, target.key)
      if (chatId !== undefined) return { model: target.id, chats }
      return { model: target.id, chats, unbuiltGroups: (await store.vectors.unbuiltGroups(account)).length }
    },

    refresh: async ({
      chat,
      model: choice = DEFAULT_TEXT_MODEL,
      build = true,
      embed = true,
      maxChats = REFRESH_BOUNDS.maxChats,
      maxChunks = REFRESH_BOUNDS.maxChunks,
      threads,
      progress,
      maxMessages,
      check,
      messages = true,
    }) => {
      check?.()
      const store = await deps.store()
      const account = await deps.account()
      const target = embeddingTarget(deps, choice)
      if (embed && !build && !target.installed) throw notDownloaded(target.id)
      const chatId =
        chat === undefined ? undefined : await storedChatId(deps.messenger, chat, store, account, { includeLeft: true })
      const scan = async () => ({
        chats: (await readinessOf(deps, chatId, target.key)).sort(byOldestBuild),
        unbuilt: chatId === undefined ? await store.vectors.unbuiltGroups(account) : [],
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
      const wantsMessages = embed && messages && target.installed && choice === DEFAULT_TEXT_MODEL
      const toEmbed = wantsMessages ? await messagesToEmbed(chatId, target.key, maxChunks, check) : undefined
      let messagesEmbedded = 0
      if (embed && target.installed) {
        const fresh = new Set(built.map(({ chat }) => chat))
        const queue = (await scan()).chats
          .filter(needsEmbed)
          .sort((a, b) => Number(fresh.has(b.chat)) - Number(fresh.has(a.chat)))
          .slice(0, maxChats)
        if (queue.length > 0 || toEmbed?.items.length) {
          await withEmbedder(deps, target, choice, { threads }, async (embedder) => {
            let budget = maxChunks
            for (const { chat } of queue) {
              if (budget <= 0) break
              check?.()
              const done = await embedInto(chat, target, embedder, { maxChunks: budget, check })
              budget -= done.embedded + done.skipped
              embedded.push(done)
              progress?.(`chat ${chat}: ${done.embedded} chunks embedded with ${target.id}`)
            }
            if (toEmbed?.items.length && budget > 0) {
              messagesEmbedded = await embedMessages(toEmbed.items.slice(0, budget), target, embedder, check)
              progress?.(`${messagesEmbedded} messages embedded with ${target.id}`)
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
        ...(toEmbed
          ? {
              messages: {
                embedded: messagesEmbedded,
                left: toEmbed.items.length + toEmbed.beyond - messagesEmbedded,
              },
            }
          : {}),
      }
    },

    clear: async (chat, choice) => {
      const store = await deps.store()
      const account = await deps.account()
      const chatId = await storedChatId(deps.messenger, chat, store, account, { includeLeft: true })
      const cleared = await store.vectors.clearVectors(
        account,
        chatId,
        choice === undefined ? undefined : embeddingTarget(deps, choice).key,
      )
      return { chat: chatId, cleared }
    },
  }
}

const needsBuild = (one: ChatReadiness) => one.graph === null || isStale(one)

const needsEmbed = (one: ChatReadiness) => one.graph !== null && one.vectors.missing > 0

/** Never finished first, then the oldest build: the longest-waiting change goes first. */
const byOldestBuild = (a: ChatReadiness, b: ChatReadiness) =>
  (a.graph?.builtAt ?? "").localeCompare(b.graph?.builtAt ?? "")

export const isStale = ({ graph, pending, vectors }: ChatReadiness) =>
  Boolean(graph?.outdatedRules) || pending.new + pending.edited + pending.deleted > 0 || vectors.stale > 0

export const shaped = ({ chatId, builtAt, algorithmVersion, pending, vectors }: StoredReadiness): ChatReadiness => {
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
