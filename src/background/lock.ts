import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { resolvePaths, writeSecurely } from "@wirecat/cli-base"
import type { AppIdentity } from "../cli/app.js"
import { alive } from "./processes.js"

export interface Lock {
  pid: number
  startedAt: string
  /** Set once the connection is open and updates arrive — before it, `serve` is still starting. */
  listeningAt?: string
  /** The CLI version this serve runs: after an update it goes on running the old code until restarted. */
  version?: string
}

export const lockPath = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv) =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "serve", `${profile}.lock`)

export const readLock = (path: string): Lock | undefined => {
  try {
    const lock = JSON.parse(readFileSync(path, "utf8")) as Partial<Lock>
    return typeof lock.pid === "number" && typeof lock.startedAt === "string" ? (lock as Lock) : undefined
  } catch {
    return undefined
  }
}

export const holdLock = (path: string, lock: Lock) => writeSecurely(path, `${JSON.stringify(lock)}\n`, 0o600)

/**
 * Takes the lock unless a live process holds it, and then answers that holder. The lock appears by
 * `link`, which fails if the file exists, and appears already written: two serves started in the same
 * instant cannot both pass, and none reads a half-written lock as stale.
 */
export const takeLock = (path: string, lock: Lock): Lock | undefined => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const draft = `${path}.${lock.pid}.tmp`
  writeFileSync(draft, `${JSON.stringify(lock)}\n`, { mode: 0o600 })
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        linkSync(draft, path)
        return undefined
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      const held = readLock(path)
      if (held && held.pid !== lock.pid && alive(held.pid)) return held
      rmSync(path, { force: true })
    }
    throw new Error(`could not take the lock ${path}: it keeps changing`)
  } finally {
    rmSync(draft, { force: true })
  }
}

/** Only the process that holds the lock removes it: one refused as a second serve must not free it. */
export const releaseLock = (path: string, pid = process.pid) => {
  if (readLock(path)?.pid === pid) rmSync(path, { force: true })
}

/** The profiles a serve is running for now — what an update must restart for its new code to run. */
export const servingProfiles = (app: AppIdentity, env: NodeJS.ProcessEnv): string[] => {
  const dir = dirname(lockPath(app, "default", env))
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(".lock"))
    .map((name) => name.slice(0, -".lock".length))
    .filter((profile) => {
      const lock = readLock(lockPath(app, profile, env))
      return lock !== undefined && alive(lock.pid)
    })
}
