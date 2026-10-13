import { CliError } from "@wirecat/cli-base"
import { CHUNK_CHARS } from "../conversations/chunks.js"
import { DEFAULT_TEXT_MODEL } from "../embeddings/models.js"
import { type Built, conversationsService } from "./conversations.js"
import type { Embedded, EmbeddingsService } from "./embedding-contracts.js"
import { byOldestBuild, needsBuild, needsEmbed } from "./embedding-readiness.js"
import { type EmbeddingRuntime, type EmbeddingRuntimeDeps, embeddingRuntime } from "./embedding-runtime.js"
import { storedChatId } from "./message-resolution.js"

/** How much one run without `--chat` does at most, by default. */
export const REFRESH_BOUNDS = { maxChats: 20, maxChunks: 2_000 }

/** e5's tokenizer reads ~3.7 characters a token in Russian; 3 keeps the bound above the real count. */
const CHARS_PER_TOKEN_AT_LEAST = 3
export type EmbeddingsMaintenanceService = Pick<
  EmbeddingsService,
  "status" | "embed" | "readiness" | "refresh" | "clear"
>
export const embeddingsMaintenanceService = (
  deps: EmbeddingRuntimeDeps,
  runtime: Pick<
    EmbeddingRuntime,
    "resolve" | "notDownloaded" | "found" | "readinessOf" | "withEmbedder" | "embedInto"
  > = embeddingRuntime(deps),
): EmbeddingsMaintenanceService => {
  const { resolve, notDownloaded, found, readinessOf, withEmbedder, embedInto } = runtime

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
