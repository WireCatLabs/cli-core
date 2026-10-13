import type { MessageStore } from "../../store/store.js"
import { failureKey } from "../failures.js"

export const STEMS_EVERY_MS = 30_000
export const STEMS_SLICE_MS = 2_000

export interface StemFills {
  /** Starts filling; a second call is ignored. */
  start(): void
  /** Clears the timer and waits for a slice in progress. */
  stop(): Promise<void>
  summary(): { stemmed: number }
}

/**
 * `serve`'s fill of stems still building — after an upgrade changed the default stemmers, a large store
 * would otherwise wait for a search or `store migrate`. A short slice per interval, so the store stays free
 * for everything else; it ends when the stems are ready, and never touches stems waiting for a reindex.
 */
export const stemFills = ({
  withStore,
  warn,
  everyMs = STEMS_EVERY_MS,
  sliceMs = STEMS_SLICE_MS,
}: {
  withStore: <T>(work: (store: MessageStore) => Promise<T>) => Promise<T>
  warn: (text: string) => void
  everyMs?: number
  sliceMs?: number
}): StemFills => {
  let timer: NodeJS.Timeout | undefined
  let slice = Promise.resolve()
  let stopped = false
  let stemmed = 0

  const fillOnce = () =>
    withStore(async (store) => {
      const state = await store.stemsState()
      if (!state || state.ready || state.cause !== "building") return false
      const stop = Date.now() + sliceMs
      stemmed += (await store.fillStems({ until: () => stopped || Date.now() >= stop })).stemmed
      return !(await store.stemsState())?.ready
    })

  const tick = () => {
    slice = fillOnce()
      .catch((error) => {
        warn(`the stems were not filled: ${failureKey(error)}`)
        return true
      })
      .then((more) => {
        if (more && !stopped) timer = setTimeout(tick, everyMs)
      })
  }

  return {
    start: () => {
      if (timer === undefined && !stopped) timer = setTimeout(tick, 0)
    },
    stop: async () => {
      stopped = true
      clearTimeout(timer)
      await slice
    },
    summary: () => ({ stemmed }),
  }
}
