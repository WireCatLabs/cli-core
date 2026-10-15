import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolvePaths } from "@wirecat/cli-base"
import type { AppIdentity } from "../ports/app.js"
import { withFileLock } from "./file-lock.js"

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
  reserve(): number {
    const now = this.now()
    if (this.interval === 0) return now
    return withFileLock(this.path, "the request pace", () => {
      const tat = Math.max(this.read(), now)
      this.write(tat + this.interval)
      return Math.max(now, tat - this.rate.burst * this.interval)
    })
  }

  /** The messenger asked every caller to wait: nothing goes before `now + waitMs`, in any process. */
  holdFor(waitMs: number): void {
    if (this.interval === 0) return
    withFileLock(this.path, "the request pace", () => {
      const hold = this.now() + waitMs + this.rate.burst * this.interval
      this.write(Math.max(this.read(), hold))
    })
  }

  /** The owner's `flood clear`: every process may go again at once. */
  reset(): void {
    withFileLock(this.path, "the request pace", () => this.write(0))
  }

  private read(): number {
    try {
      const tat = Number((JSON.parse(readFileSync(this.path, "utf8")) as { tat?: unknown }).tat)
      return Number.isFinite(tat) ? tat : 0
    } catch {
      return 0
    }
  }

  private write(tat: number): void {
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify({ tat }), { mode: 0o600 })
    renameSync(temporary, this.path)
  }
}
