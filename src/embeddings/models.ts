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

/** The cosine a meaning hit must beat, measured in bench/search-quality; an unmeasured model keeps every hit. */
export const meaningFloor = (key: string): number => (key === "local:e5-small:384" ? 0.8 : 0)
