import type { Embedder } from "../embeddings/embed.js"
import { DEFAULT_TEXT_MODEL } from "../embeddings/models.js"
import type { AccountKey } from "../store/store.js"
import type { ServiceDeps } from "./deps.js"
import { embeddingTarget, type ModelDeps, withEmbedder } from "./embeddings-maintenance.js"
import { MEANING_DEPTH, type MeaningLane, type MeaningRanked } from "./messages-discovery.js"
import { plainWords } from "./pictures.js"

/**
 * Discovery's meaning half: the default local model over each message's own vector. It runs only when the model is
 * on disk and vectors exist — never a download, never a remote model — and any failure leaves the words alone.
 */
export const meaningLane =
  (deps: ModelDeps & Pick<ServiceDeps, "store">): MeaningLane =>
  async (question, accounts, shared, within) => {
    const target = embeddingTarget(deps, DEFAULT_TEXT_MODEL)
    const skipped = (reason: string, step?: "models.download" | "conversations.rebuild") => ({
      skipped: { reason, model: target.id, ...(step ? { step } : {}) },
    })
    if (!target.installed) return skipped(`${target.id} is not downloaded`, "models.download")
    const store = await deps.store()
    const ready: AccountKey[] = []
    const without: AccountKey[] = []
    for (const one of accounts) ((await store.vectors.hasMessageVectors(one, target.key)) ? ready : without).push(one)
    if (ready.length === 0) return skipped("no message has a vector yet", "conversations.rebuild")
    const words = plainWords(question)
    try {
      const ranked: MeaningRanked = []
      if (words) {
        const pks = await within?.()
        const lookUp = async (embedder: Embedder) => {
          const [query] = await embedder.embed([words], "query")
          for (const one of ready) {
            const near = pks
              ? await store.vectors.scoreMessages(one, { model: target.key, query: query as Float32Array, pks })
              : await store.vectors.nearestMessages(one, {
                  model: target.key,
                  limit: MEANING_DEPTH,
                  query: query as Float32Array,
                })
            for (const { chatId, messageId, score } of near) ranked.push({ ...one, chatId, id: messageId, score })
          }
        }
        if (shared && !deps.embedders) await lookUp(await shared.get(target.key, () => target.open()))
        else await withEmbedder(deps, target, DEFAULT_TEXT_MODEL, {}, lookUp)
      }
      return {
        model: target.id,
        ranked: ranked.sort((a, b) => b.score - a.score).slice(0, MEANING_DEPTH),
        ...(without.length
          ? {
              partly: skipped(
                `${without.map(({ provider, account }) => `${provider}:${account}`).join(", ")} has no message vectors yet`,
                "conversations.rebuild",
              ).skipped,
            }
          : {}),
      }
    } catch (error) {
      return skipped(`${target.id} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
