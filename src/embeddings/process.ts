import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import type { Embedder, Kind } from "./embed.js"
import type { RerankModel, TextModel } from "./models.js"
import type { Reranker } from "./rerank.js"

type Answer = { ready: true } | Reply
type Reply = { id: number; vectors?: number[][]; scores?: number[]; error?: string }
type Request = { texts: string[]; kind?: Kind; question?: string }

/**
 * One session in a process of its own, run by the same runtime. When it exits, all of its memory goes back:
 * closing the session gives back ~0.1 of ~1 GB, and on Bun ending a worker thread gives back none for good
 * (measured 2026-10-02, docs/storage/search-indexes.md).
 */
export const openProcess = async (
  model: TextModel,
  directory: string,
  { threads }: { threads: number },
): Promise<Embedder> => {
  const child = await modelProcess({ model, directory, threads })
  return {
    model,
    embed: async (texts, kind) =>
      ((await child.ask({ texts, kind })).vectors ?? []).map((vector) => Float32Array.from(vector)),
    close: child.close,
  }
}

/** The reranker the same way, for the MCP server. */
export const openRerankerProcess = async (
  model: RerankModel,
  directory: string,
  { threads }: { threads: number },
): Promise<Reranker> => {
  const child = await modelProcess({ model, directory, threads, rerank: true })
  return {
    model,
    score: async (question, passages) => (await child.ask({ question, texts: passages })).scores ?? [],
    close: child.close,
  }
}

const modelProcess = async (setup: object) => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./child.js", import.meta.url)), JSON.stringify(setup)],
    { stdio: ["pipe", "pipe", "pipe"] },
  )
  const pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>()
  let said = ""
  child.stderr.setEncoding("utf8").on("data", (text: string) => {
    said = (said + text).slice(-2_000)
  })
  let ready = () => {}
  let refused = (_error: Error) => {}
  const started = new Promise<void>((resolve, reject) => {
    ready = resolve
    refused = reject
  })
  let gone: Error | undefined
  const stopped = (error: Error) => {
    gone ??= error
    refused(error)
    for (const job of pending.values()) job.reject(error)
    pending.clear()
  }
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code) => {
      const last = said.trim().split("\n").at(-1)
      stopped(new Error(`the embedding process stopped (exit ${code})${last ? `: ${last}` : ""}`))
      resolve()
    })
  })
  child.once("error", stopped)
  createInterface({ input: child.stdout }).on("line", (line) => {
    const answer = JSON.parse(line) as Answer
    if ("ready" in answer) return ready()
    const job = pending.get(answer.id)
    pending.delete(answer.id)
    if (answer.error !== undefined || !(answer.vectors ?? answer.scores))
      job?.reject(new Error(answer.error ?? "no answer"))
    else job?.resolve(answer)
  })
  await started
  let next = 0
  return {
    ask: (request: Request) =>
      new Promise<Reply>((resolve, reject) => {
        if (gone) return reject(gone)
        const id = next++
        pending.set(id, { resolve, reject })
        child.stdin.write(`${JSON.stringify({ id, ...request })}\n`)
      }),
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) child.stdin.end()
      await exited
    },
  }
}
