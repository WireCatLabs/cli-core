import { createInterface } from "node:readline"
import { type Kind, openEmbedder } from "./embed.js"
import type { RerankModel, TextModel } from "./models.js"
import { openReranker } from "./rerank.js"

const { model, directory, threads, rerank } = JSON.parse(process.argv[2] ?? "{}") as {
  model: TextModel & RerankModel
  directory: string
  threads: number
  rerank?: boolean
}
const session = rerank
  ? { reranker: await openReranker(model, directory, { threads }) }
  : { embedder: await openEmbedder(model, directory, { threads }) }
// stdout carries the answers alone, one JSON line each: anything else there breaks the parent's reading.
const answer = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`)
answer({ ready: true })
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { id: number; texts: string[]; kind: Kind; question: string }
  const { id } = request
  try {
    if (session.reranker) answer({ id, scores: await session.reranker.score(request.question, request.texts) })
    else if (session.embedder)
      answer({
        id,
        vectors: (await session.embedder.embed(request.texts, request.kind)).map((vector) => Array.from(vector)),
      })
  } catch (error) {
    answer({ id, error: error instanceof Error ? error.message : String(error) })
  }
}
await (session.reranker ?? session.embedder)?.close()
process.exit(0)
