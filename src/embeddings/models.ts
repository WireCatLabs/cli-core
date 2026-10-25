import { CliError } from "@wirecat/cli-base"
import type { ModelFile } from "../speech/models.js"

/**
 * The text embedding models `conversations embed` can use, each **pinned to one commit** and checked by
 * sha256, as the speech models are. Measured 2026-10-02 through `@wirecat/cli-core-onnx`, 4 threads, a
 * Ryzen AI 9 HX 470 laptop, 300-token chunks, Node 24 and Bun 1.3.14 alike
 * (`docs/storage/research/2026-10-02-embeddings.md`): e5-small ~10 chunks a second, EmbeddingGemma ~1.5.
 */
export interface TextModel {
  id: string
  title: string
  languages: string
  licence: string
  /** A licence the user accepts before the model is downloaded, or nothing for an open one. */
  terms?: string
  dims: number
  /** What the model was trained on; a longer text is cut. */
  maxTokens: number
  /** About how many ~300-token chunks a second one session embeds on 8 threads, for the estimate. */
  chunksPerSecond: number
  /** How the model's output becomes one vector. */
  pooling: "mean" | "sentence_embedding"
  /** Prepended to a search and to a stored chunk: the model was trained with them. */
  prefix: { query: string; passage: string }
  files: ModelFile[]
  /** The ONNX file among `files`, and the weights it keeps beside itself, if any. */
  onnx: string
  externalData?: string
}

const huggingFace = (repository: string, commit: string) => (name: string) =>
  `https://huggingface.co/${repository}/resolve/${commit}/${name}`

const e5 = huggingFace("Xenova/multilingual-e5-small", "761b726dd34fb83930e26aab4e9ac3899aa1fa78")
const gemma = huggingFace("onnx-community/embeddinggemma-300m-ONNX", "5090578d9565bb06545b4552f76e6bc2c93e4a66")

export const TEXT_MODELS: TextModel[] = [
  {
    id: "e5-small",
    title: "multilingual-e5-small, 8-bit",
    languages: "about 100 languages, Russian and English among them",
    licence: "MIT",
    dims: 384,
    maxTokens: 512,
    // 100k-message corpus, one 8-thread session on Ryzen AI 9 HX 470: 31–32 chunks/s.
    chunksPerSecond: 31,
    pooling: "mean",
    prefix: { query: "query: ", passage: "passage: " },
    onnx: "onnx/model_quantized.onnx",
    files: [
      {
        name: "onnx/model_quantized.onnx",
        url: e5("onnx/model_quantized.onnx"),
        sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
        bytes: 118_308_185,
      },
      {
        name: "tokenizer.json",
        url: e5("tokenizer.json"),
        sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
        bytes: 17_082_730,
      },
      {
        name: "tokenizer_config.json",
        url: e5("tokenizer_config.json"),
        sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
        bytes: 443,
      },
    ],
  },
  {
    id: "embeddinggemma",
    title: "EmbeddingGemma 300M, 4-bit",
    languages: "over 100 languages — the best of the two on chat, about seven times slower",
    licence: "Gemma Terms of Use",
    terms: "https://ai.google.dev/gemma/terms",
    dims: 768,
    maxTokens: 2048,
    chunksPerSecond: 2,
    pooling: "sentence_embedding",
    prefix: { query: "task: search result | query: ", passage: "title: none | text: " },
    onnx: "onnx/model_q4.onnx",
    externalData: "onnx/model_q4.onnx_data",
    files: [
      {
        name: "onnx/model_q4.onnx",
        url: gemma("onnx/model_q4.onnx"),
        sha256: "ad1dfee81a70f7944b9b9d1cc6e48075b832881cf33fab2f2b248be78f3f0043",
        bytes: 519_322,
      },
      {
        name: "onnx/model_q4.onnx_data",
        url: gemma("onnx/model_q4.onnx_data"),
        sha256: "599962c3143b040de2dd05e5975be3e9091dd067cacc6a8f7186e3203bab9e02",
        bytes: 196_725_760,
      },
      {
        name: "tokenizer.json",
        url: gemma("tokenizer.json"),
        sha256: "4dda02faaf32bc91031dc8c88457ac272b00c1016cc679757d1c441b248b9c47",
        bytes: 20_323_312,
      },
      {
        name: "tokenizer_config.json",
        url: gemma("tokenizer_config.json"),
        sha256: "3ca953eea6c3c9fcda9cf3df22949ff18b216f7c74bd6459230f3f1013953f3a",
        bytes: 1_156_830,
      },
    ],
  },
]

export const DEFAULT_TEXT_MODEL = "e5-small"

export const textModel = (id: string): TextModel => {
  const found = TEXT_MODELS.find((model) => model.id === id)
  if (!found) {
    throw new CliError(
      "validation_error",
      `no text model ${id} — one of: ${TEXT_MODELS.map((model) => model.id).join(", ")}`,
    )
  }
  return found
}

/**
 * Cross-encoders that read a question and one hit together and score how well the hit answers it: discovery's
 * last step. Pinned and checked as the text models are, and kept beside them. Picked in the evidence-pipeline
 * benchmark (cli-testing performance/search/evidence-pipeline, "Reranker variants").
 */
export interface RerankModel {
  id: string
  title: string
  languages: string
  licence: string
  /** Question and hit together; a longer pair loses the end of the hit. */
  maxTokens: number
  files: ModelFile[]
  onnx: string
}

const mmarco = huggingFace("cross-encoder/mmarco-mMiniLMv2-L12-H384-v1", "1427fd652930e4ba29e8149678df786c240d8825")
const bge = huggingFace("onnx-community/bge-reranker-v2-m3-ONNX", "6f5ff65298512715a1e669753bc754d2bc8f367b")

export const RERANK_MODELS: RerankModel[] = [
  {
    id: "mmarco",
    title: "mMARCO mMiniLMv2-L12 cross-encoder, 8-bit",
    languages: "about 100 languages, Russian and English among them",
    licence: "Apache-2.0",
    maxTokens: 512,
    // The x86 name is the quantizer's target; Core runs every model as WebAssembly, on any processor.
    onnx: "onnx/model_quint8_avx2.onnx",
    files: [
      {
        name: "onnx/model_quint8_avx2.onnx",
        url: mmarco("onnx/model_quint8_avx2.onnx"),
        sha256: "6c2513767fb63d008a4377bef7a7a3555433d9436342bb53e35a3a72ffc52d4b",
        bytes: 118_620_016,
      },
      {
        name: "tokenizer.json",
        url: mmarco("tokenizer.json"),
        sha256: "62c24cdc13d4c9952d63718d6c9fa4c287974249e16b7ade6d5a85e7bbb75626",
        bytes: 17_082_660,
      },
      {
        name: "tokenizer_config.json",
        url: mmarco("tokenizer_config.json"),
        sha256: "e7fbfbfa6347b4e414c1cee50d142e2c2f9a895dad68b068ae83a8b564c3837e",
        bytes: 435,
      },
    ],
  },
  {
    id: "bge-reranker-v2-m3",
    title: "BGE reranker v2 m3, 8-bit",
    languages: "over 100 languages — better than mmarco in the benchmark, about seven times slower",
    licence: "Apache-2.0 (BAAI's; the ONNX export declares none)",
    maxTokens: 512,
    onnx: "onnx/model_quantized.onnx",
    files: [
      {
        name: "onnx/model_quantized.onnx",
        url: bge("onnx/model_quantized.onnx"),
        sha256: "912fc1215c2dbff6499700534bd8d31253af01573861abbfc43afd1fab6cce5d",
        bytes: 570_727_094,
      },
      {
        name: "tokenizer.json",
        url: bge("tokenizer.json"),
        sha256: "8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3",
        bytes: 17_082_900,
      },
      {
        name: "tokenizer_config.json",
        url: bge("tokenizer_config.json"),
        sha256: "b87c8703482b0300d3da30e201519aa641f6a450f5eb5bf1e624afbf70c74d80",
        bytes: 1_203,
      },
    ],
  },
]

export const DEFAULT_RERANK_MODEL = "mmarco"

export const rerankModel = (id: string): RerankModel => {
  const found = RERANK_MODELS.find((model) => model.id === id)
  if (!found) {
    throw new CliError(
      "validation_error",
      `no reranker ${id} — one of: ${RERANK_MODELS.map((model) => model.id).join(", ")}`,
    )
  }
  return found
}

/** The cosine a meaning hit must beat, measured in bench/search-quality; an unmeasured model keeps every hit. */
/** A vector's model: the provider, the model and its size — vectors of two of them never mix. */
export const vectorModelKey = (model: TextModel): string => `local:${model.id}:${model.dims}`

export const meaningFloor = (key: string): number => (key === "local:e5-small:384" ? 0.8 : 0)
