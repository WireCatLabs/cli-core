import { readFileSync } from "node:fs"
import { join } from "node:path"
import { resolvePaths, writeSecurely } from "@wirecat/cli-base"
import type { AppIdentity } from "../app.js"

export interface ReviewPoint {
  /** ms: the newest mention a `--new` run showed; `undefined` before the first, so every undecided one is new. */
  after: number | undefined
  /** Moves the point to the newest mention shown; a run that showed nothing leaves it. */
  save(foundAt: readonly string[]): void
}

/**
 * Where `mentions list --new` stopped, per profile, beside `inbox`'s points. One point for the owner and an agent
 * alike: an agent's review is the review the owner asked for.
 */
export const reviewPoint = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv): ReviewPoint => {
  const file = join(
    resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state,
    "mentions",
    `${profile}.json`,
  )
  const after = read(file)
  return {
    after,
    save: (foundAt) => {
      const newest = Math.max(...foundAt.map((at) => Date.parse(at)).filter(Number.isFinite))
      if (!Number.isFinite(newest) || (after !== undefined && newest <= after)) return
      writeSecurely(file, `${JSON.stringify({ reviewedThrough: new Date(newest).toISOString() })}\n`, 0o600)
    },
  }
}

const read = (file: string): number | undefined => {
  try {
    const { reviewedThrough } = JSON.parse(readFileSync(file, "utf8")) as { reviewedThrough?: unknown }
    const at = typeof reviewedThrough === "string" ? Date.parse(reviewedThrough) : Number.NaN
    return Number.isFinite(at) ? at : undefined
  } catch {
    return undefined
  }
}
