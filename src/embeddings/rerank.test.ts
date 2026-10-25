import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { RerankModel } from "./models.js"
import { openReranker } from "./rerank.js"

const tiny: RerankModel = {
  id: "tiny-rerank",
  title: "scores how often cat or kitten occurs in the pair",
  languages: "test",
  licence: "none",
  maxTokens: 6,
  onnx: "onnx/model.onnx",
  files: [],
}
const directory = fileURLToPath(new URL("./fixtures", import.meta.url))

describe("reranker", () => {
  it("reads the question and each passage together, in order", async () => {
    const reranker = await openReranker(tiny, directory, { threads: 1 })
    try {
      expect(await reranker.score("cat", ["dog", "kitten cat", "fish"])).toEqual([1, 3, 1])
    } finally {
      await reranker.close()
    }
  })

  it("cuts a pair longer than the model reads", async () => {
    const reranker = await openReranker(tiny, directory, { threads: 1 })
    try {
      expect(await reranker.score("dog", ["dog dog dog dog cat cat dog"])).toEqual([0])
    } finally {
      await reranker.close()
    }
  })
})
