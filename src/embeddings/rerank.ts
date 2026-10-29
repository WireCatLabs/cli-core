import { defaultThreads, loadModel, truncated } from "./embed.js"
import type { RerankModel } from "./models.js"

export interface Reranker {
  readonly model: RerankModel
  /** How well each passage answers the question, in order: the model's raw logit, higher is better. */
  score(question: string, passages: string[]): Promise<number[]>
  close(): Promise<void>
}

export const openReranker = async (
  model: RerankModel,
  directory: string,
  { threads = defaultThreads() }: { threads?: number } = {},
): Promise<Reranker> => {
  const { ort, tokenizer, session } = await loadModel(model, directory, threads)
  const typeIds = session.inputNames.includes("token_type_ids")
  const cap = Number(process.env.WIRECAT_BENCH_RERANK_TOKENS) || model.maxTokens
  const output = session.outputNames[0] as string

  const one = async (question: string, passage: string): Promise<number> => {
    const encoded = tokenizer.encode(question, { text_pair: passage, return_token_type_ids: true })
    if (process.env.WIRECAT_BENCH_TOKENS) process.stderr.write(`bench-tokens ${encoded.ids.length}\n`)
    const ids = truncated(encoded.ids, cap)
    const shape = [1, ids.length]
    const feeds: Record<string, InstanceType<typeof ort.Tensor>> = {
      input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), shape),
      attention_mask: new ort.Tensor("int64", new BigInt64Array(ids.length).fill(1n), shape),
    }
    if (typeIds)
      feeds.token_type_ids = new ort.Tensor(
        "int64",
        BigInt64Array.from(truncated(encoded.token_type_ids, cap), BigInt),
        shape,
      )
    const logit = (await session.run(feeds))[output]?.data[0]
    if (typeof logit !== "number" || !Number.isFinite(logit)) throw new Error(`${model.id} gave no score`)
    return logit
  }

  return {
    model,
    score: async (question, passages) => {
      const scores: number[] = []
      for (const passage of passages) scores.push(await one(question, passage))
      return scores
    },
    close: () => session.release(),
  }
}
