import { Worker } from "node:worker_threads"
import { CliError } from "@wirecat/cli-base"
import { exhausted, QUERY_LIMITS } from "./lucene/types.js"

const workerSource = `const {parentPort,workerData}=require("node:worker_threads");
const pattern=new RegExp(workerData.source,workerData.flags);
parentPort.postMessage(workerData.texts.flatMap((text,index)=>{pattern.lastIndex=0;return pattern.test(text)?[index]:[]}));`
export const isolatedRegex = async (
  pattern: RegExp,
  texts: string[],
  options: {
    signal?: AbortSignal
    timeoutMs?: number
    worker?: (source: string, flags: string, texts: string[]) => Worker
  } = {},
): Promise<number[]> => {
  if ([...pattern.source].length > QUERY_LIMITS.pattern) exhausted("pattern")
  if (texts.length > QUERY_LIMITS.candidates) exhausted("candidate rows")
  if (texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0) > QUERY_LIMITS.bodyBytes) exhausted("body bytes")
  if (options.signal?.aborted)
    throw new CliError("validation_error", "search was aborted", { reason: "query.aborted", complete: false })
  const worker =
    options.worker?.(pattern.source, pattern.flags, texts) ??
    new Worker(workerSource, {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
      workerData: { source: pattern.source, flags: pattern.flags, texts },
    })
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await new Promise<number[]>((resolve, reject) => {
      worker.once("message", (result: unknown) => {
        if (
          !Array.isArray(result) ||
          !result.every((id: unknown) => Number.isInteger(id) && Number(id) >= 0 && Number(id) < texts.length)
        )
          reject(new CliError("validation_error", "the regex worker returned an invalid result"))
        else resolve(result as number[])
      })
      worker.once("error", () => reject(new CliError("validation_error", "the regex worker failed")))
      worker.once("exit", () => reject(new CliError("validation_error", "the regex worker exited before answering")))
      abort = () =>
        reject(new CliError("validation_error", "search was aborted", { reason: "query.aborted", complete: false }))
      options.signal?.addEventListener("abort", abort, { once: true })
      timer = setTimeout(
        () =>
          reject(
            new CliError(
              "validation_error",
              "legacy regex exceeded its time budget — narrow the query or use Lucene regex",
              { reason: "query.too-large", budget: "time", complete: false },
            ),
          ),
        options.timeoutMs ?? QUERY_LIMITS.milliseconds,
      )
    })
  } finally {
    if (timer) clearTimeout(timer)
    if (abort) options.signal?.removeEventListener("abort", abort)
    await worker.terminate()
  }
}
