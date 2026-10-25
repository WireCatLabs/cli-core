import { CliError } from "@wirecat/cli-base"
import type { Id } from "../domain/models.js"
import type { ServiceDeps } from "./deps.js"
import type { Refreshed } from "./embeddings.js"
import { embeddingsMaintenance } from "./embeddings-maintenance.js"

export const CATCH_UP_BOUNDS = { maxChunks: 500, maxMessages: 10_000, timeMs: 30_000 }
export interface CatchUpOptions {
  maxChunks?: number
  maxMessages?: number
  timeMs?: number
}
export interface CatchUpResult {
  complete: boolean
  reason?: "message_bound" | "time_or_abort_bound" | "preparation_failed" | "pending"
  prepared?: Refreshed
}
export const validateCatchUpBounds = (options: CatchUpOptions) => {
  for (const [key, value, maximum] of [
    ["maxChunks", options.maxChunks ?? CATCH_UP_BOUNDS.maxChunks, 20_000],
    ["maxMessages", options.maxMessages ?? CATCH_UP_BOUNDS.maxMessages, 100_000],
    ["timeMs", options.timeMs ?? CATCH_UP_BOUNDS.timeMs, 300_000],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new CliError("validation_error", `catch-up ${key} must be between 1 and ${maximum}`)
}

export const validateCatchUp = (deps: ServiceDeps, options: CatchUpOptions) => {
  validateCatchUpBounds(options)
  for (const key of ["conversations.links", "conversations.embeddings"] as const)
    deps.guard.check({ chatId: null, key }, { reserve: false })
}

export const catchUpSearch = async (
  deps: ServiceDeps,
  chat: Id,
  options: CatchUpOptions,
  signal: AbortSignal,
  clock: () => number = Date.now,
): Promise<CatchUpResult> => {
  const started = clock()
  const maxMessages = options.maxMessages ?? CATCH_UP_BOUNDS.maxMessages
  const timeMs = options.timeMs ?? CATCH_UP_BOUNDS.timeMs
  const check = () => {
    signal.throwIfAborted()
    if (clock() - started >= timeMs) throw new DOMException("catch-up time budget reached", "AbortError")
  }
  try {
    check()
    if ((await (await deps.store()).messages.countMessages(await deps.account(), chat)) > maxMessages)
      return { complete: false, reason: "message_bound" }
    const prepared = await embeddingsMaintenance(deps).refresh({
      chat,
      model: "e5-small",
      maxChats: 1,
      maxChunks: options.maxChunks ?? CATCH_UP_BOUNDS.maxChunks,
      maxMessages,
      check,
      threads: 1,
      messages: false,
    })
    check()
    return {
      complete: prepared.left.length === 0,
      ...(prepared.left.length ? { reason: "pending" as const } : {}),
      prepared,
    }
  } catch {
    return {
      complete: false,
      reason: signal.aborted || clock() - started >= timeMs ? "time_or_abort_bound" : "preparation_failed",
    }
  }
}
