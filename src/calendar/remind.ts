import { spawn } from "node:child_process"
import { CliError } from "@wirecat/cli-base"
import { checkpointPath, readCheckpoint, saveCheckpoint } from "../background/checkpoints.js"
import { releaseLock, takeLock } from "../background/lock.js"
import { type EventDetails, type EventStore, eventItem } from "../meetings/index.js"
import { ownsTime } from "./prepare.js"
import { eventOf } from "./reads.js"

const DAY = 86_400_000
/** More would be a calendar that is not the owner's own; the rest wait for the next run. */
const REMIND_MAX = 50
/** A program that has not finished by then is stopped, so a stuck one does not hold the next run's lock. */
export const HOOK_TIMEOUT_MS = 60_000
const KILL_AFTER_MS = 5_000

const UNTRUSTED = ["title", "description", "location"]

export type Reminded = Record<string, string>

/** One key per event and start: a meeting moved to another time is reminded again. */
const keyOf = (details: EventDetails) => `${details.event.id}@${new Date(details.event.startsAt ?? 0).toISOString()}`

export const remindersPath = (state: string, profile: string) => checkpointPath(state, profile, "events-remind")

/** Events that take the owner's time and start in the window, earliest first, and are not yet reminded. */
export const dueEvents = async (
  store: EventStore,
  accountId: number,
  window: { from: number; to: number },
  reminded: Reminded,
): Promise<EventDetails[]> => {
  const due: EventDetails[] = []
  for (const one of await store.events({ accountId, startsFrom: window.from, to: window.to, limit: REMIND_MAX })) {
    const details = await eventOf(store, accountId, one.id).catch(() => undefined)
    if (details && ownsTime(details) && reminded[keyOf(details)] === undefined) due.push(details)
  }
  return due
}

export const reminderItem = (details: EventDetails) => ({
  ...eventItem(details.event),
  ref: `event:${details.event.id}`,
  untrusted: UNTRUSTED,
})

/**
 * Runs the owner's program with the reminder as JSON on its standard input, never through a shell: the event's text
 * is a stranger's, and only the program's own argv, typed by the owner, is on its command line.
 */
export const runHook = (
  argv: readonly string[],
  input: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = HOOK_TIMEOUT_MS,
): Promise<number> =>
  new Promise((resolve) => {
    const [program = "", ...args] = argv
    const child = spawn(program, args, { env, shell: false, stdio: ["pipe", "ignore", "inherit"], windowsHide: true })
    let kill: NodeJS.Timeout | undefined
    const stop = setTimeout(() => {
      child.kill("SIGTERM")
      kill = setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS)
    }, timeoutMs)
    const done = (code: number) => {
      clearTimeout(stop)
      if (kill) clearTimeout(kill)
      resolve(code)
    }
    child.on("error", () => done(127))
    child.on("close", (code, signal) => done(code ?? (signal === "SIGKILL" ? 137 : 143)))
    // A program that reads nothing closes its end first; that is its choice, not a failure.
    child.stdin.on("error", () => {})
    child.stdin.end(input)
  })

/**
 * What was reminded, and the lock that keeps two runs from reminding the same event at once. `remember` keeps a day
 * of past starts and forgets older ones.
 */
export const openReminders = (path: string, now: number) => {
  const lock = `${path}.lock`
  const held = takeLock(lock, { pid: process.pid, startedAt: new Date(now).toISOString() })
  if (held)
    throw new CliError("validation_error", `another events remind is running (pid ${held.pid}); this run did nothing`, {
      reason: "remind.running",
      retryable: true,
    })
  const reminded: Reminded = { ...readCheckpoint<Reminded>(path)?.cursor }
  return {
    reminded,
    remember: (details: EventDetails) => {
      reminded[keyOf(details)] = new Date(now).toISOString()
      const kept = Object.fromEntries(
        Object.entries(reminded).filter(([key]) => Date.parse(key.slice(key.indexOf("@") + 1)) >= now - DAY),
      )
      saveCheckpoint(path, { cursor: kept, done: Object.keys(kept).length }, new Date(now))
    },
    close: () => releaseLock(lock),
  }
}
