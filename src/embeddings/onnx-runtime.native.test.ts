import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { allowNetwork } from "@wirecat/cli-base/testing"
import { describe, expect, it, onTestFinished } from "vitest"
import { loadModel, openEmbedder } from "./embed.js"
import type { RerankModel, TextModel } from "./models.js"
import { installNativeRuntime, nativeRuntimeFor, onnxRuntime } from "./onnx-runtime.js"
import { openReranker } from "./rerank.js"

// Downloads the real library: run by the native-runtime workflow on each system, never by `pnpm test`.
const expected = process.env.NATIVE_RUNTIME_CHECK

const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url))
const tinyText: TextModel = {
  id: "tiny",
  title: "a five-word model",
  languages: "test",
  licence: "none",
  dims: 4,
  maxTokens: 3,
  chunksPerSecond: 1,
  pooling: "mean",
  prefix: { query: "fish ", passage: "" },
  onnx: "onnx/model.onnx",
  files: [],
}
const tinyRerank: RerankModel = {
  id: "tiny-rerank",
  title: "scores how often cat or kitten occurs in the pair",
  languages: "test",
  licence: "none",
  maxTokens: 6,
  onnx: "onnx/model.onnx",
  files: [],
}

describe.skipIf(!expected)("the native ONNX Runtime on this system", () => {
  it(
    expected === "native" ? "downloads, loads and runs both tiny models natively" : "is not offered here",
    async () => {
      onTestFinished(allowNetwork())
      const env = { ...process.env, WIRECAT_STATE_DIR: mkdtempSync(join(tmpdir(), "native-runtime-")) }
      process.env.WIRECAT_STATE_DIR = env.WIRECAT_STATE_DIR

      const folder = await installNativeRuntime({ env })
      const runtime = await onnxRuntime(env)

      if (expected !== "native") {
        expect([folder, nativeRuntimeFor(), runtime.native]).toEqual([undefined, undefined, false])
        return
      }
      expect(runtime.native).toBe(true)
      const { ort } = await loadModel(tinyText, fixtures, 2)
      expect(ort).toBe(runtime.ort)
      const embedder = await openEmbedder(tinyText, fixtures, { threads: 2 })
      const reranker = await openReranker(tinyRerank, fixtures, { threads: 2 })
      try {
        const [catDog] = await embedder.embed(["cat dog"], "passage")
        expect(Array.from(catDog ?? []).map((value) => value.toFixed(4))).toEqual([
          "0.7071",
          "0.7071",
          "0.0000",
          "0.0000",
        ])
        expect(await reranker.score("cat", ["dog", "kitten cat", "fish"])).toEqual([1, 3, 1])
      } finally {
        await embedder.close()
        await reranker.close()
      }
    },
  )
})
