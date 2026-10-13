import { CliError } from "@wirecat/cli-base"
import { chunkHash, chunkTextOf } from "../conversations/chunks.js"
import type { Id } from "../domain/models.js"
import { defaultThreads, type Embedder, isTextModelInstalled, textModelsDirectory } from "../embeddings/embed.js"
import { DEFAULT_TEXT_MODEL, type TextModel, textModel } from "../embeddings/models.js"
import { remoteKey } from "../embeddings/remote.js"
import type { ServiceDeps } from "./deps.js"
import type { ChatReadiness, Embedded, ModelChoice } from "./embedding-contracts.js"
import { shaped } from "./embedding-readiness.js"
import { storedChatId } from "./message-resolution.js"

/** A vector's model: the provider, the model and its size — vectors of two of them never mix. */
export const vectorModelKey = (model: TextModel): string => `local:${model.id}:${model.dims}`

/** Chunks per batch for one local session; one short transaction writes each batch. */
const PER_SESSION = 8

/** Texts per remote request; `concurrency` of them run at once. */
const PER_REQUEST = 256
export type EmbeddingRuntimeDeps = Pick<ServiceDeps, "store" | "account" | "env" | "embedders"> & {
  messenger: Pick<ServiceDeps["messenger"], "app" | "savedChatId">
}
export const embeddingRuntime = (deps: EmbeddingRuntimeDeps) => {
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
  return { command, notDownloaded, notBuiltError, resolve, readinessOf, found, withEmbedder, embedInto }
}
export type EmbeddingRuntime = ReturnType<typeof embeddingRuntime>
