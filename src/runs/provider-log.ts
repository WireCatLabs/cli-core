import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { resolvePaths } from "@wirecat/cli-base"
import type { AppIdentity } from "../ports/app.js"

/**
 * The messenger library's warnings for one profile, always kept: a message it failed to decrypt is lost without a
 * trace otherwise. One JSON object per line, `{"time","level","kind"?,"message"}` — the shape zerolog writes, so an
 * engine in another process appends to the file directly. **No phone number, id of a person or message text**: the
 * adapter or its engine masks before writing. `kind` is the adapter's tag (`decrypt`), counted by `doctor`.
 */
export const providerLogPathFor = (app: AppIdentity, profile: string, env: NodeJS.ProcessEnv = process.env): string =>
  join(resolvePaths({ appName: app.appName, prefix: app.envPrefix, env }).state, "provider-log", `${profile}.jsonl`)

export const PROVIDER_LOG_BYTES = 1024 * 1024

const previousOf = (path: string): string => path.replace(/\.jsonl$/, ".1.jsonl")

/**
 * The file, private and under its cap, ready for an engine to append to. The cap is kept here rather than by the
 * writer, because an engine in another language appends without knowing it: one older file is kept.
 */
export const openProviderLog = (path: string, maxBytes = PROVIDER_LOG_BYTES): string => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (existsSync(path) && statSync(path).size >= maxBytes) renameSync(path, previousOf(path))
  closeSync(openSync(path, "a", 0o600))
  chmodSync(path, 0o600)
  return path
}

export const writeProviderWarning = (path: string, kind: string, message: string, now = new Date()): void => {
  openProviderLog(path)
  appendFileSync(path, `${JSON.stringify({ time: now.toISOString(), level: "warn", kind, message })}\n`)
}

export interface ProviderWarnings {
  path: string
  total: number
  kinds: Record<string, number>
}

/** Warnings since `since`, by kind; a line without one counts as `other`, a line that is not JSON is skipped. */
export const providerWarnings = (path: string, since: Date): ProviderWarnings => {
  const kinds: Record<string, number> = {}
  let total = 0
  for (const file of [previousOf(path), path]) {
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue
      let entry: { time?: unknown; kind?: unknown }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const at = typeof entry.time === "string" ? Date.parse(entry.time) : Number.NaN
      if (!(at >= since.getTime())) continue
      const kind = typeof entry.kind === "string" && entry.kind ? entry.kind : "other"
      kinds[kind] = (kinds[kind] ?? 0) + 1
      total++
    }
  }
  return { path, total, kinds }
}
