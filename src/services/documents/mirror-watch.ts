import { watch } from "node:fs"
import { CliError, isCliError } from "@wirecat/cli-base"
import type { PushStatePort } from "../../documents/push-model.js"
import { type Mirror, mirrorStatus } from "./mirrors.js"
import { skippedName } from "./push.js"

/** What started a cycle: the first run, a local save, a remote change, the periodic local check, or a full run. */
export type MirrorTrigger = "start" | "local" | "remote" | "check" | "full"

export type MirrorWatchEvent<T> =
  | { triggers: MirrorTrigger[]; mirrors: string[]; result: T }
  | { triggers: MirrorTrigger[]; mirrors: string[]; error: CliError }

export interface MirrorWatchOptions<S> {
  mirrors: Mirror[]
  signal: AbortSignal
  kindOf(path: string): string | undefined
  stateOf(mirror: Mirror): PushStatePort<S>
  /** Ids of the mirrors whose remote files changed since the last call, or `all` when the provider cannot tell. */
  remoteChanges?(signal: AbortSignal): Promise<string[] | "all">
  pollMs?: number
  quietMs?: number
  /** How often local files are compared with the state, for file events the system dropped. */
  checkMs?: number
  /** How often every mirror is synced whatever the triggers said, for remote changes the provider listed late. */
  fullMs?: number
  watchFolder?(root: string, changed: () => void): () => void
  sleep?(milliseconds: number, signal: AbortSignal): Promise<void>
  now?(): number
}

const sleep = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener("abort", finish, { once: true })
  })

const watchFolder = (root: string, changed: () => void) => {
  try {
    const watcher = watch(root, { recursive: true }, (_event, name) => {
      if (name === null || !name.split(/[\\/]/).some(skippedName)) changed()
    })
    // A lost watcher only delays a sync until the periodic check; it never stops the watch.
    watcher.on("error", () => watcher.close())
    return () => watcher.close()
  } catch {
    return () => {}
  }
}

const failure = (error: unknown) =>
  isCliError(error) ? error : new CliError("provider_error", "the sync cycle failed")

/**
 * Keeps mirrors in sync until `signal` aborts: a cycle at start, then one for each mirror whose files were saved
 * (after `quietMs` without another save), whose remote files changed, or whose files differ from the state at the
 * periodic check; every mirror at each full run. A local trigger syncs only when the files differ from the state, so
 * the files a pull writes do not start another cycle. A failed cycle is reported and its mirrors tried again at the
 * next poll; the watch goes on.
 */
export async function* watchMirrors<S, T>(
  sync: (mirrors: Mirror[], signal: AbortSignal) => Promise<T>,
  options: MirrorWatchOptions<S>,
): AsyncGenerator<MirrorWatchEvent<T>, void, void> {
  const { mirrors, signal } = options
  const pollMs = options.pollMs ?? 60_000
  const quietMs = options.quietMs ?? 2_000
  const checkMs = options.checkMs ?? 300_000
  const fullMs = options.fullMs ?? 1_800_000
  const now = options.now ?? Date.now
  const wait = options.sleep ?? sleep
  const byId = new Map(mirrors.map((mirror) => [mirror.id, mirror]))
  const saved = new Map<string, number>()
  const retry = new Set<string>()
  let wake = new AbortController()
  const closers = mirrors.map((mirror) =>
    (options.watchFolder ?? watchFolder)(mirror.path, () => {
      saved.set(mirror.id, now())
      wake.abort()
    }),
  )
  const differs = async (ids: Iterable<string>) => {
    const chosen = [...ids].flatMap((id) => byId.get(id) ?? [])
    try {
      const items = await mirrorStatus(chosen, options.kindOf, options.stateOf)
      return items.filter((item) => item.create.length || item.update.length).map((item) => item.id)
    } catch {
      // An unreadable folder is for the sync to report.
      return chosen.map((mirror) => mirror.id)
    }
  }
  const run = async (triggers: MirrorTrigger[], ids: Set<string>): Promise<MirrorWatchEvent<T>> => {
    const chosen = mirrors.filter((mirror) => ids.has(mirror.id))
    const names = chosen.map((mirror) => mirror.id)
    try {
      return { triggers, mirrors: names, result: await sync(chosen, signal) }
    } catch (error) {
      for (const id of names) retry.add(id)
      return { triggers, mirrors: names, error: failure(error) }
    }
  }

  try {
    if (signal.aborted) return
    const first = await run(["start"], new Set(byId.keys()))
    // A cycle cut short by the stop is the stop, not a failure.
    if (signal.aborted && "error" in first) return
    yield first
    let nextPoll = now() + pollMs
    let nextCheck = now() + checkMs
    let nextFull = now() + fullMs
    while (!signal.aborted) {
      let due = Math.min(nextPoll, nextCheck, nextFull)
      for (const at of saved.values()) due = Math.min(due, at + quietMs)
      const until = due - now()
      if (until > 0) {
        await wait(until, AbortSignal.any([signal, wake.signal]))
        if (wake.signal.aborted) wake = new AbortController()
        if (signal.aborted) return
        continue
      }
      const at = now()
      const triggers: MirrorTrigger[] = []
      const ids = new Set<string>()
      const add = (trigger: MirrorTrigger, found: Iterable<string>) => {
        const before = ids.size
        for (const id of found) ids.add(id)
        if (ids.size > before && !triggers.includes(trigger)) triggers.push(trigger)
      }
      if (at >= nextFull) {
        add("full", byId.keys())
        nextFull = at + fullMs
        nextCheck = at + checkMs
        nextPoll = at + pollMs
        saved.clear()
        retry.clear()
      } else {
        const settled = [...saved].filter(([, saveAt]) => saveAt + quietMs <= at).map(([id]) => id)
        for (const id of settled) saved.delete(id)
        if (settled.length) add("local", await differs(settled))
        if (at >= nextCheck) {
          add("check", await differs(byId.keys()))
          nextCheck = at + checkMs
        }
        if (at >= nextPoll) {
          nextPoll = at + pollMs
          add("remote", retry)
          retry.clear()
          if (options.remoteChanges)
            try {
              const changed = await options.remoteChanges(signal)
              add("remote", changed === "all" ? byId.keys() : changed.filter((id) => byId.has(id)))
            } catch (error) {
              if (signal.aborted) return
              yield { triggers: ["remote"], mirrors: [], error: failure(error) }
            }
        }
      }
      if (signal.aborted || !ids.size) continue
      const event = await run(triggers, ids)
      if (signal.aborted && "error" in event) return
      yield event
    }
  } finally {
    for (const close of closers) close()
  }
}
