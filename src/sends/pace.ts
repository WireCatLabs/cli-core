import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CliError, resolvePaths } from "@wirecat/cli-base"
import type { AppIdentity } from "../ports/app.js"
import type { Warn } from "../runs/events.js"
import { withFileLockAsync } from "./file-lock.js"

/** How fast one profile may ask its messenger, counted across every process using it. */
export interface PaceRate {
  /** 0 turns pacing off. */
  perMinute: number
  /** Calls that may go at once before the rest are spaced. */
  burst: number
}

/** One call a second after a burst of 20: what a single `messages sync` already did with its 1 s page pause. */
export const DEFAULT_PACE: PaceRate = { perMinute: 60, burst: 20 }

/** `<state dir>/pace/<profile>.json`, beside `flood/`. */
export const pacePathFor = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv = process.env): string =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "pace", `${profile}.json`)

/**
 * One request pace per profile, shared through a file so two commands, a background job and `serve` count
 * against the same allowance. A generic cell-rate algorithm: `tat` is when the allowance is back to empty; a
 * call may go once `tat - burst × interval` has passed, and moves `tat` one interval on.
 */
export class Pacer {
  constructor(
    readonly path: string,
    private readonly rate: PaceRate,
    private readonly now: () => number = Date.now,
  ) {}

  get interval(): number {
    return this.rate.perMinute > 0 ? 60_000 / this.rate.perMinute : 0
  }

  /** When this call may go; reserved at once, so the next caller in any process lines up behind it. */
  async reserve(): Promise<number> {
    if (this.interval === 0) return this.now()
    return withFileLockAsync(this.path, "the request pace", () => {
      // Inside the lock: read earlier, another process's write would look like a clock step.
      const now = this.now()
      const tat = Math.max(this.read(now), now)
      this.write(tat + this.interval, now)
      return Math.max(now, tat - this.rate.burst * this.interval)
    })
  }

  /** The messenger asked every caller to wait: nothing goes before `now + waitMs`, in any process. */
  async holdFor(waitMs: number): Promise<void> {
    if (this.interval === 0) return
    await withFileLockAsync(this.path, "the request pace", () => {
      const now = this.now()
      const hold = now + waitMs + this.rate.burst * this.interval
      this.write(Math.max(this.read(now), hold), now)
    })
  }

  /** The owner's `flood clear`: every process may go again at once. */
  async reset(): Promise<void> {
    await withFileLockAsync(this.path, "the request pace", () => this.write(0, this.now()))
  }

  private read(now: number): number {
    try {
      const file = JSON.parse(readFileSync(this.path, "utf8")) as { tat?: unknown; at?: unknown }
      const tat = Number(file.tat)
      if (!Number.isFinite(tat)) return 0
      const at = Number(file.at)
      // Written "in the future" means the clock went back since, as when a machine boots ahead and NTP steps it. What
      // was left of the wait still holds; the absolute time, hours off, does not.
      return Number.isFinite(at) && at > now ? now + Math.max(0, tat - at) : tat
    } catch {
      return 0
    }
  }

  private write(tat: number, at: number): void {
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify({ tat, at }), { mode: 0o600 })
    renameSync(temporary, this.path)
  }
}

/** Shorter waits pass unannounced; a person at a terminal would not notice them. */
const ANNOUNCE_WAIT_MS = 5_000
/** Longer than this the pace refuses instead of waiting, as a run already ends at a wait this long. */
const LONGEST_PACE_WAIT_MS = 5 * 60_000

export interface TurnOptions {
  /** The provider, as a person calls it: `Telegram`, `Bitrix24`. */
  name: string
  /** The call waiting, as a warning names it. */
  operation: string
  /** Says so when the wait is long enough to notice, and when the pace file could not be read. */
  warn?: Warn
  /** Waits; a timer when absent. A test or a cancellable run passes its own. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * Waits for this call's turn in the profile's pace, the same wait for every provider: a short one silently, a long
 * one with a warning, and one longer than a run would wait is refused as `rate_limited`, nothing sent. A pace file
 * that cannot be read lets the call go: pacing is a courtesy to the provider, not a lock.
 */
export const waitForTurn = async (pacer: Pacer, options: TurnOptions): Promise<void> => {
  const { name, operation, warn } = options
  const now = options.now ?? Date.now
  let at = now()
  try {
    at = await pacer.reserve()
  } catch (error) {
    warn?.(`could not remember ${name}'s wait (${error instanceof Error ? error.message : String(error)})`, {
      event: "warning",
      code: "wait_not_remembered",
      operation,
    })
  }
  const waitMs = at - now()
  if (waitMs <= 0) return
  if (waitMs > LONGEST_PACE_WAIT_MS)
    throw new CliError(
      "rate_limited",
      `this profile's next request to ${name} has to wait ${Math.ceil(waitMs / 1000)} s more — nothing was sent to ${name}`,
      { retry_after_ms: waitMs, retry_at: new Date(at).toISOString(), remembered: true },
    )
  if (waitMs >= ANNOUNCE_WAIT_MS) {
    const seconds = Math.ceil(waitMs / 1000)
    warn?.(`waiting ${seconds} s to keep this profile's pace with ${name}`, {
      event: "warning",
      code: "pace_wait",
      operation,
      counts: { seconds },
    })
  }
  await (options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(waitMs)
}
