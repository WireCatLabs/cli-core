import { readFileSync } from "node:fs"
import { availableParallelism } from "node:os"
import { basename, join } from "node:path"
import { filesPresent, sharedModelsDirectory } from "../speech/install.js"
import type { TextModel } from "./models.js"
import type { Reranker } from "./rerank.js"

export const textModelsDirectory = (env: NodeJS.ProcessEnv = process.env): string => sharedModelsDirectory("text", env)

export const placedText = (model: Pick<TextModel, "id" | "files">, directory: string) =>
  model.files.map((file) => [file, join(directory, model.id, file.name)] as [typeof file, string])

export const isTextModelInstalled = (model: Pick<TextModel, "id" | "files">, directory: string): boolean =>
  filesPresent(placedText(model, directory))

/** Past 8 threads one session gains nothing; Bun takes 1 unless told (`2026-10-02-embeddings.md`). */
export const defaultThreads = (): number => Math.min(8, availableParallelism())

export type Kind = "query" | "passage"

export interface Embedder {
  readonly model: TextModel
  /** One unit vector per text, in order. */
  embed(texts: string[], kind: Kind): Promise<Float32Array[]>
  close(): Promise<void>
}

/**
 * Models a long-running process keeps open between searches — the MCP server, where loading one costs
 * ~1 s a call. One no search has used for `idleMs` is closed, and the next search loads it again: e5-small
 * holds ~1 GB, for as long as an agent's session lasts otherwise. Whoever makes it closes it; a one-shot
 * command never makes one.
 */
export interface WarmEmbedders {
  get(key: string, open: () => Promise<Embedder>): Promise<Embedder>
  reranker(key: string, open: () => Promise<Reranker>): Promise<Reranker>
  close(): Promise<void>
}

export const WARM_IDLE_MS = 10 * 60_000

type Queue = ReturnType<typeof queue>

/** One search's models, so the parts of a search that need the same model load it once; closed when it ends. */
export const runEmbedders = (): Pick<WarmEmbedders, "get" | "close"> => {
  const held = new Map<string, Promise<Embedder>>()
  return {
    get: (key, open) => {
      const one = held.get(key) ?? open()
      held.set(key, one)
      return one
    },
    close: async () => {
      await Promise.allSettled([...held.values()].map(async (one) => (await one).close()))
    },
  }
}

export const warmEmbedders = ({ idleMs = WARM_IDLE_MS }: { idleMs?: number } = {}): WarmEmbedders => {
  const held = new Map<string, Promise<{ close(): Promise<void> }>>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const running = new Map<string, number>()
  const drop = (key: string) => {
    const one = held.get(key)
    held.delete(key)
    clearTimeout(timers.get(key))
    timers.delete(key)
    return one
  }
  const rearm = (key: string) => {
    clearTimeout(timers.get(key))
    const timer = setTimeout(() => {
      // A search still running rearms the clock when it ends.
      if (running.get(key)) return
      drop(key)
        ?.then((one) => one.close())
        .catch(() => {})
    }, idleMs)
    // The MCP server exits when its client goes; a timer must not hold it open.
    timer.unref?.()
    timers.set(key, timer)
  }
  const hold = <T extends { close(): Promise<void> }>(
    key: string,
    open: () => Promise<T>,
    serial: (one: T, run: Queue) => T,
  ): Promise<T> => {
    let opening = held.get(key) as Promise<T> | undefined
    if (!opening) {
      const started = open().then((one) =>
        serial(
          one,
          queue({
            starts: () => running.set(key, (running.get(key) ?? 0) + 1),
            ends: () => {
              running.set(key, (running.get(key) ?? 1) - 1)
              rearm(key)
            },
          }),
        ),
      )
      held.set(key, started)
      // A model not downloaded yet must not stay refused once it is.
      started.catch(() => {
        if (held.get(key) === started) drop(key)
      })
      opening = started
    }
    rearm(key)
    return opening
  }
  return {
    get: (key, open) =>
      hold(key, open, (embedder, run) => ({
        model: embedder.model,
        embed: (texts, kind) => run.next(() => embedder.embed(texts, kind)),
        close: run.closing(() => embedder.close()),
      })),
    reranker: (key, open) =>
      hold(key, open, (reranker, run) => ({
        model: reranker.model,
        score: (question, passages) => run.next(() => reranker.score(question, passages)),
        close: run.closing(() => reranker.close()),
      })),
    close: async () => {
      const all = [...held.keys()].map(drop)
      await Promise.allSettled(all.map(async (one) => (await one)?.close()))
    },
  }
}

/** Two MCP calls may arrive at once; a session is not documented to take overlapping runs. */
const queue = ({ starts, ends }: { starts: () => void; ends: () => void }) => {
  let last: Promise<unknown> = Promise.resolve()
  return {
    next: <R>(work: () => Promise<R>): Promise<R> => {
      starts()
      const next = last.then(work)
      last = next.then(ends, ends)
      return next
    },
    /** Closing waits for the run in progress. */
    closing: (close: () => Promise<void>) => async (): Promise<void> => {
      await last
      await close()
    },
  }
}

/** A text longer than the model's limit keeps its beginning and the closing special token. */
export const truncated = (ids: number[], max: number): number[] =>
  ids.length <= max ? ids : [...ids.slice(0, max - 1), ids.at(-1) as number]

export const unit = (vector: Float32Array): Float32Array => {
  let sum = 0
  for (const value of vector) sum += value * value
  const length = Math.sqrt(sum)
  return length === 0 ? vector : vector.map((value) => value / length)
}

/** The mean over a single text's tokens: one text a run, so no padding to mask. */
export const meanOf = (data: Float32Array, tokens: number, dims: number): Float32Array => {
  const mean = new Float32Array(dims)
  for (let token = 0; token < tokens; token++) {
    for (let dim = 0; dim < dims; dim++)
      mean[dim] = (mean[dim] as number) + (data[token * dims + dim] as number) / tokens
  }
  return mean
}

/** A model's tokenizer and ONNX session, from its folder. */
export const loadModel = async (
  model: { id: string; onnx: string; externalData?: string },
  directory: string,
  threads: number,
) => {
  const [{ Tokenizer }, ort] = await Promise.all([import("@huggingface/tokenizers"), import("@wirecat/cli-core-onnx")])
  const path = (name: string) => join(directory, model.id, name)
  const tokenizer = new Tokenizer(
    JSON.parse(readFileSync(path("tokenizer.json"), "utf8")),
    JSON.parse(readFileSync(path("tokenizer_config.json"), "utf8")),
  )
  ort.env.wasm.numThreads = threads
  const session = await ort.InferenceSession.create(
    readFileSync(path(model.onnx)),
    model.externalData
      ? { externalData: [{ path: basename(model.externalData), data: readFileSync(path(model.externalData)) }] }
      : {},
  )
  return { ort, tokenizer, session }
}

export const openEmbedder = async (
  model: TextModel,
  directory: string,
  { threads = defaultThreads() }: { threads?: number } = {},
): Promise<Embedder> => {
  const { ort, tokenizer, session } = await loadModel(model, directory, threads)
  const typeIds = session.inputNames.includes("token_type_ids")

  const one = async (text: string): Promise<Float32Array> => {
    const ids = truncated(tokenizer.encode(text).ids, model.maxTokens)
    const shape = [1, ids.length]
    const feeds: Record<string, InstanceType<typeof ort.Tensor>> = {
      input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), shape),
      attention_mask: new ort.Tensor("int64", new BigInt64Array(ids.length).fill(1n), shape),
    }
    if (typeIds) feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(ids.length), shape)
    const output = await session.run(feeds)
    if (model.pooling === "sentence_embedding") {
      return unit(Float32Array.from(output.sentence_embedding?.data as Float32Array))
    }
    const hidden = output.last_hidden_state
    if (!hidden) throw new Error(`${model.id} gave no last_hidden_state`)
    return unit(meanOf(hidden.data as Float32Array, ids.length, hidden.dims.at(-1) as number))
  }

  return {
    model,
    embed: async (texts, kind) => {
      const vectors: Float32Array[] = []
      for (const text of texts) vectors.push(await one(`${model.prefix[kind]}${text}`))
      return vectors
    },
    close: () => session.release(),
  }
}
