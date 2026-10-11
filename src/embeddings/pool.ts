import { freemem } from "node:os"
import { CliError } from "@wirecat/cli-base"
import { defaultThreads, type Embedder, openEmbedder } from "./embed.js"
import type { TextModel } from "./models.js"

/** Each worker holds its own copy of the model: 550–650 MB measured for e5-small (phase 5 E12). */
export const WORKER_BYTES = 700_000_000

/**
 * One session in this thread, or `workers` sessions in worker threads with the threads split between
 * them. Correction 2026-10-03: the 100k-message benchmark measured 3 workers at 1.04–1.1× one
 * session on 8 threads, with ~2.6–2.7 GB RSS against Node's 1.2 GB (bench/embeddings/README.md).
 * The research's ~1.8× used 4 threads per worker against one session on 4, not this allocation.
 * Refuses a count whose copies would not fit in free memory.
 */
export const openPool = async (
  model: TextModel,
  directory: string,
  {
    workers = 1,
    threads = defaultThreads(),
    free = freemem(),
  }: { workers?: number; threads?: number; free?: number } = {},
): Promise<Embedder> => {
  if (workers <= 1) return openEmbedder(model, directory, { threads })
  if (workers * WORKER_BYTES > free) {
    throw new CliError(
      "validation_error",
      `${workers} workers need about ${Math.round((workers * WORKER_BYTES) / 1e9)} GB, and ${Math.floor(free / 1e9)} GB is free — use fewer`,
    )
  }
  const { openWorkers } = await import("./workers.js")
  return openWorkers(model, directory, { workers, threads: Math.max(1, Math.floor(threads / workers)) })
}
