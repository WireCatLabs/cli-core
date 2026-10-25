import { defaultThreads, isTextModelInstalled, textModelsDirectory } from "../embeddings/embed.js"
import { DEFAULT_RERANK_MODEL, rerankModel } from "../embeddings/models.js"
import type { ServiceDeps } from "./deps.js"
import type { RerankLane } from "./messages-discovery.js"
import { plainWords } from "./pictures.js"

/**
 * Discovery's last step: the reranker reads the question with each of the first hits. It runs only when the model
 * is on disk — never a download, never a remote model — and any failure leaves discovery's order alone.
 */
export const rerankLane = (deps: ServiceDeps): RerankLane | undefined => {
  const choice = deps.reranker ?? DEFAULT_RERANK_MODEL
  if (choice === "off") return undefined
  return async () => {
    const model = rerankModel(choice)
    const directory = textModelsDirectory(deps.env)
    if (!isTextModelInstalled(model, directory))
      return { skipped: { reason: `${model.id} is not downloaded`, step: "models.download", model: model.id } }
    try {
      const warm = deps.embedders
      const reranker = warm
        ? await warm.reranker(`rerank:${model.id}`, async () =>
            (await import("../embeddings/process.js")).openRerankerProcess(model, directory, {
              threads: defaultThreads(),
            }),
          )
        : await (await import("../embeddings/rerank.js")).openReranker(model, directory)
      return {
        model: model.id,
        score: (question, passages) => reranker.score(plainWords(question), passages),
        done: async () => {
          if (!warm) await reranker.close()
        },
      }
    } catch (error) {
      return {
        skipped: {
          reason: `${model.id} failed: ${error instanceof Error ? error.message : String(error)}`,
          model: model.id,
        },
      }
    }
  }
}
