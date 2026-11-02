import type { Chat } from "../../domain/models.js"
import { failureKey } from "../../errors/failures.js"
import type { ServeNotice } from "./serve-notice.js"

/** The provider's own catch-up lands first; this pass then finds most chats already current. */
export const START_SYNC_DELAY_MS = 30_000
export const START_SYNC_BUDGET_MS = 5 * 60_000
/** A longer downtime is `messages sync --all`'s job, not a start's. */
export const START_SYNC_WINDOW_MS = 7 * 86_400_000
export const START_SYNC_PER_CHAT = 500

export interface StartSyncSummary {
  chats: number
  fetched: number
  failed: number
  stopped: boolean
}

export interface StartSync {
  /** Runs the pass once, after the delay; a second call is ignored. */
  start(): void
  /** Aborts the pass and waits for it, which stops before its next request. */
  stop(): Promise<void>
  summary(): StartSyncSummary | undefined
}

/**
 * `serve`'s one pass on start over the chats that moved while nothing listened. A provider's own
 * catch-up drops a gap it finds too long (Telegram's `differenceTooLong`, `channelDifferenceTooLong`
 * past 100 updates), so each chat whose newest message is newer than the newest one held is read back
 * to that one. A chat never held is read back to the newest message held anywhere, which is about when
 * the last serve stopped. Bounded by a window, a per-chat limit and a time budget; an empty store is
 * left to `messages sync --all`.
 */
export const startSync = ({
  chats,
  newestHeld,
  fetch,
  note,
  warn,
  delayMs = START_SYNC_DELAY_MS,
  budgetMs = START_SYNC_BUDGET_MS,
  windowMs = START_SYNC_WINDOW_MS,
  now = Date.now,
}: {
  chats: (stop: AbortSignal) => Promise<Chat[]>
  /** The newest message held from before this serve started, epoch milliseconds. */
  newestHeld: (chatId: string) => Promise<number | undefined>
  fetch: (chatId: string, sinceMs: number, stop: AbortSignal) => Promise<{ fetched: number }>
  note: (notice: ServeNotice) => void
  warn: (notice: ServeNotice) => void
  delayMs?: number
  budgetMs?: number
  windowMs?: number
  now?: () => number
}): StartSync => {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  let pass: Promise<void> = Promise.resolve()
  let started = false
  let done: StartSyncSummary | undefined

  const run = async () => {
    const stop = AbortSignal.any([controller.signal, AbortSignal.timeout(budgetMs)])
    const floor = now() - windowMs
    const moved: { chat: Chat; lastAt: number; held: number | undefined }[] = []
    for (const chat of await chats(stop)) {
      const lastAt = Date.parse(chat.lastMessageAt ?? "")
      if (Number.isNaN(lastAt) || lastAt < floor) continue
      moved.push({ chat, lastAt, held: await newestHeld(chat.id) })
    }
    const anywhere = moved.reduce((top, { held }) => (held === undefined ? top : Math.max(top, held)), -Infinity)
    if (!Number.isFinite(anywhere)) return
    const behind = moved
      .filter(({ lastAt, held }) => lastAt > (held ?? anywhere))
      .sort((one, other) => other.lastAt - one.lastAt)
    if (behind.length === 0) return
    const summary: StartSyncSummary = { chats: 0, fetched: 0, failed: 0, stopped: false }
    done = summary
    for (const { chat, held } of behind) {
      if (stop.aborted) break
      try {
        summary.fetched += (await fetch(chat.id, Math.max(held ?? anywhere, floor), stop)).fetched
        summary.chats += 1
      } catch (error) {
        if (stop.aborted) break
        summary.failed += 1
        const errorCode = failureKey(error)
        warn({
          code: "start_sync_chat_failed",
          chatId: chat.id,
          errorCode,
          text: `what ${chat.id} received while serve was down was not fetched: ${errorCode}`,
        })
      }
    }
    summary.stopped = stop.aborted && summary.chats + summary.failed < behind.length
    note({
      code: "start_sync",
      text:
        `caught up ${summary.fetched} message(s) in ${summary.chats} chat(s) that moved while serve was down` +
        (summary.stopped ? ` — stopped at the time limit, ${behind.length - summary.chats - summary.failed} left` : ""),
    })
  }

  return {
    start: () => {
      if (started || controller.signal.aborted) return
      started = true
      timer = setTimeout(() => {
        pass = run().catch((error) => {
          if (controller.signal.aborted) return
          const errorCode = failureKey(error)
          warn({ code: "start_sync_failed", errorCode, text: `the catch-up on start failed: ${errorCode}` })
        })
      }, delayMs)
    },
    stop: async () => {
      controller.abort()
      clearTimeout(timer)
      await pass
    },
    summary: () => done,
  }
}
