import type { AccountKey, MessageStore } from "../../store/store.js"
import { failureKey } from "../failures.js"
import type { ServeNotice } from "./serve-notice.js"

/** After connecting, `serve` waits this long before its first member fetch: catch-up comes first. */
export const FIRST_FETCH_MS = 60_000
export const DAY_MS = 86_400_000

export interface MemberFetches {
  /** Starts the daily round; a second call is ignored. */
  start(): void
  /** Clears the timer and waits for a round in progress, which stops before its next chat. */
  stop(): Promise<void>
  summary(): { fetched: number; failed: number }
}

/**
 * `serve`'s daily fetch of every tracked chat's member list, one chat after another, each under the fetch's
 * own page budget and pause. A chat already fetched today is skipped, so a restart does not fetch it again.
 */
export const memberFetches = ({
  withStore,
  fetch,
  warn,
  firstMs = FIRST_FETCH_MS,
  everyMs = DAY_MS,
}: {
  withStore: <T>(work: (store: MessageStore, account: AccountKey) => Promise<T>) => Promise<T>
  fetch: (store: MessageStore, account: AccountKey, chatId: string) => Promise<unknown>
  warn: (notice: ServeNotice) => void
  firstMs?: number
  everyMs?: number
}): MemberFetches => {
  let timer: NodeJS.Timeout | undefined
  let round = Promise.resolve()
  let stopped = false
  const done = { fetched: 0, failed: 0 }

  const fetchAll = () =>
    withStore(async (store, account) => {
      const today = new Date().toISOString().slice(0, 10)
      for (const { chatId, lastCount } of await store.trackedChats(account)) {
        if (stopped) return
        if (lastCount?.day === today) continue
        try {
          await fetch(store, account, chatId)
          done.fetched += 1
        } catch (error) {
          done.failed += 1
          const errorCode = failureKey(error)
          warn({
            code: "members_not_fetched",
            chatId,
            errorCode,
            text: `members of ${chatId} were not fetched: ${errorCode}`,
          })
        }
      }
    })

  const tick = () => {
    const next = Date.now() + everyMs
    round = fetchAll()
      .catch((error) => {
        const errorCode = failureKey(error)
        warn({ code: "member_fetch_failed", errorCode, text: `the daily member fetch failed: ${errorCode}` })
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, Math.max(0, next - Date.now()))
      })
  }

  return {
    start: () => {
      if (timer === undefined && !stopped) timer = setTimeout(tick, firstMs)
    },
    stop: async () => {
      stopped = true
      clearTimeout(timer)
      await round
    },
    summary: () => ({ ...done }),
  }
}
