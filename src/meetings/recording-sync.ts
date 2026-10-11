import { CliError, type ErrorCode } from "@wirecat/cli-base"
import { snapshotMeetingScope } from "./provider.js"
import type {
  RecordingArchiveResult,
  RecordingAsset,
  RecordingCatalog,
  RecordingOccurrence,
  RecordingScope,
  RecordingWindow,
} from "./recording-source.js"

export class RecordingSyncError extends CliError {
  constructor(code: ErrorCode, message: string) {
    super(code, message)
    this.name = "RecordingSyncError"
  }
}
export interface RecordingSyncEntry {
  externalId: string
  window: RecordingWindow
  assets: RecordingAsset[]
  acknowledged: string[]
}
export interface RecordingSyncCheckpoint {
  version: 1
  scope: RecordingScope
  configKey: string
  revision: number
  updatedAt: number
  windows: RecordingWindow[]
  pendingWindows: RecordingWindow[]
  entries: RecordingSyncEntry[]
}
export interface RecordingSyncLease {
  token: string
  release(): Promise<void>
}
export interface RecordingSyncCheckpointStore {
  acquire(jobId: string): Promise<RecordingSyncLease>
  read(jobId: string, lease: string): Promise<RecordingSyncCheckpoint | null>
  save(jobId: string, lease: string, expectedRevision: number | null, state: RecordingSyncCheckpoint): Promise<void>
}
export interface RecordingSyncOptions extends RecordingWindow {
  scope: RecordingScope
  archive(occurrence: RecordingOccurrence, signal?: AbortSignal): Promise<RecordingArchiveResult>
  now(): number
  checkpoint?: { store: RecordingSyncCheckpointStore; jobId: string; configKey: string }
  recheckFrom?: string
  maxPages?: number
  maxEntries?: number
  signal?: AbortSignal
}
export interface RecordingSyncReceipt {
  window: RecordingWindow
  occurrence: Pick<RecordingOccurrence, "id" | "externalId" | "title">
  archive: RecordingArchiveResult
  availability: "unknown"
  checkpointRevision: number | null
}
const fail = (message: string, code: RecordingSyncError["code"] = "validation_error"): never => {
  throw new RecordingSyncError(code, message)
}
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 4096
const integer = (value: unknown, low: number, high: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= low && Number(value) <= high
const date = (value: unknown): Date => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return fail("archive dates must be valid YYYY-MM-DD dates")
  const result = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(result.getTime()) || result.toISOString().slice(0, 10) !== value)
    return fail("archive dates must be valid YYYY-MM-DD dates")
  return result
}
const label = (value: Date): string => value.toISOString().slice(0, 10)
const windowKey = (window: RecordingWindow): string => `${window.from}/${window.to}`
const cancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted) fail("archive synchronization cancelled", "cancelled")
}
export function recordingWindows(fromValue: string, toValue: string): RecordingWindow[] {
  const from = date(fromValue)
  const to = date(toValue)
  const anniversary = new Date(from)
  const lastDay = new Date(from)
  lastDay.setUTCFullYear(from.getUTCFullYear() + 10, from.getUTCMonth() + 1, 0)
  anniversary.setUTCFullYear(
    from.getUTCFullYear() + 10,
    from.getUTCMonth(),
    Math.min(from.getUTCDate(), lastDay.getUTCDate()),
  )
  if (to < from || to > anniversary) return fail("archive date range must be ordered and at most ten calendar years")
  const windows: RecordingWindow[] = []
  let cursor = from
  while (cursor <= to) {
    const end = new Date(cursor)
    end.setUTCMonth(end.getUTCMonth() + 1, 0)
    const upper = new Date(Math.min(end.getTime(), to.getTime()))
    windows.push({ from: label(cursor), to: label(upper) })
    cursor = new Date(upper)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return windows
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("invalid archive checkpoint or provider metadata", "invalid_response")
  return value as Record<string, unknown>
}
const scope = (value: unknown): RecordingScope => {
  const row = object(value)
  if (!text(row.provider) || !text(row.account)) return fail("archive provider and account are required")
  try {
    return snapshotMeetingScope({ provider: row.provider, account: row.account })
  } catch {
    return fail("archive provider and account must be bounded nonempty identifiers")
  }
}
const window = (value: unknown): RecordingWindow => {
  const row = object(value)
  const from = label(date(row.from))
  const to = label(date(row.to))
  if (to < from || recordingWindows(from, to).length !== 1)
    return fail("invalid archive checkpoint window", "invalid_response")
  return { from, to }
}
const nullableText = (value: unknown): value is string | null => value === null || text(value)
const asset = (value: unknown): RecordingAsset => {
  const row = object(value)
  if (
    !nullableText(row.id) ||
    !text(row.type) ||
    !nullableText(row.format) ||
    !text(row.status) ||
    typeof row.available !== "boolean" ||
    !(row.size === null || integer(row.size, 0, Number.MAX_SAFE_INTEGER)) ||
    !nullableText(row.startedAt) ||
    !nullableText(row.endedAt)
  )
    return fail("invalid recording asset metadata", "invalid_response")
  for (const value of [row.startedAt, row.endedAt])
    if (value !== null && !Number.isFinite(Date.parse(value as string)))
      return fail("invalid recording asset timestamp", "invalid_response")
  if (row.available && row.id === null) return fail("available recording assets require an id", "invalid_response")
  return {
    id: row.id,
    type: row.type,
    format: row.format,
    size: row.size,
    status: row.status,
    available: row.available,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  }
}
export const recordingAssetFingerprint = (value: RecordingAsset): string => JSON.stringify(asset(value))
const metadataSize = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength
const assets = (value: unknown): RecordingAsset[] => {
  if (!Array.isArray(value) || value.length > 1000)
    return fail("recording asset metadata exceeds its limit", "invalid_response")
  const result = value.map(asset)
  if (metadataSize(result) > 1024 ** 2)
    return fail("recording asset metadata exceeds its byte limit", "invalid_response")
  const ids = result.flatMap((item) => (item.id === null ? [] : [item.id]))
  if (new Set(ids).size !== ids.length) return fail("provider repeated a recording asset id", "invalid_response")
  return result
}
export function parseRecordingSyncCheckpoint(value: unknown, maxEntries = 10000): RecordingSyncCheckpoint {
  if (!integer(maxEntries, 1, 10000)) return fail("archive entry limit must be between 1 and 10000")
  const row = object(value)
  if (
    row.version !== 1 ||
    !text(row.configKey) ||
    !integer(row.revision, 1, Number.MAX_SAFE_INTEGER) ||
    !integer(row.updatedAt, 0, Number.MAX_SAFE_INTEGER) ||
    !Array.isArray(row.windows) ||
    row.windows.length > 1000 ||
    !Array.isArray(row.pendingWindows) ||
    row.pendingWindows.length > 1000 ||
    !Array.isArray(row.entries) ||
    row.entries.length > maxEntries
  )
    return fail("unsupported or oversized archive checkpoint", "invalid_response")
  const windows = row.windows.map(window)
  const pendingWindows = row.pendingWindows.map(window)
  let metadataBytes = 0
  const entries = row.entries.map((value): RecordingSyncEntry => {
    const entry = object(value)
    if (
      !text(entry.externalId) ||
      !Array.isArray(entry.acknowledged) ||
      entry.acknowledged.length > 1000 ||
      entry.acknowledged.some((value) => typeof value !== "string" || value.length > 65536)
    )
      return fail("invalid archive checkpoint entry", "invalid_response")
    const metadata = assets(entry.assets)
    const acknowledged = entry.acknowledged as string[]
    metadataBytes += metadataSize(metadata) + metadataSize(acknowledged)
    if (metadataBytes > 8 * 1024 ** 2) return fail("archive checkpoint exceeds its byte limit", "invalid_response")
    if (
      new Set(acknowledged).size !== acknowledged.length ||
      acknowledged.some((key) => !metadata.some((item) => item.available && recordingAssetFingerprint(item) === key))
    )
      return fail("invalid archive checkpoint acknowledgement", "invalid_response")
    return {
      externalId: entry.externalId,
      window: window(entry.window),
      assets: metadata,
      acknowledged: [...acknowledged],
    }
  })
  if (
    new Set(windows.map(windowKey)).size !== windows.length ||
    new Set(pendingWindows.map(windowKey)).size !== pendingWindows.length ||
    new Set(entries.map((entry) => entry.externalId)).size !== entries.length
  )
    return fail("duplicate archive checkpoint metadata", "invalid_response")
  return {
    version: 1,
    scope: scope(row.scope),
    configKey: row.configKey,
    revision: row.revision,
    updatedAt: row.updatedAt,
    windows,
    pendingWindows,
    entries,
  }
}
const covered = (windows: RecordingWindow[], selected: RecordingWindow): boolean =>
  windows.some((item) => item.from <= selected.from && item.to >= selected.to)
const compactWindows = (windows: RecordingWindow[], from: string): RecordingWindow[] => {
  const result: RecordingWindow[] = []
  for (const item of windows.filter((item) => item.to >= from).sort((a, b) => a.from.localeCompare(b.from))) {
    const last = result.at(-1)
    if (last && last.from.slice(0, 7) === item.from.slice(0, 7)) {
      const nextDay = date(last.to)
      nextDay.setUTCDate(nextDay.getUTCDate() + 1)
      if (item.from <= label(nextDay)) {
        last.to = last.to > item.to ? last.to : item.to
        continue
      }
    }
    result.push({ ...item })
  }
  return result
}
const pending = (entry: RecordingSyncEntry): boolean =>
  entry.assets.length === 0 ||
  entry.assets.some((item) => !item.available || !entry.acknowledged.includes(recordingAssetFingerprint(item)))
const acknowledgedAssets = (occurrence: RecordingOccurrence, result: RecordingArchiveResult): string[] => {
  if (
    result.externalId !== occurrence.externalId ||
    !text(result.manifestPath) ||
    !Array.isArray(result.downloaded) ||
    !Array.isArray(result.skipped) ||
    !Array.isArray(result.unavailable) ||
    result.downloaded.length + result.skipped.length > 1000
  )
    return fail("archive returned an invalid occurrence acknowledgement", "invalid_response")
  const completed = [...result.downloaded, ...result.skipped]
  return occurrence.assets
    .filter(
      (item) =>
        item.available &&
        completed.some(
          (file) =>
            file.id === item.id &&
            file.remoteSize === item.size &&
            file.type === item.type &&
            file.format === item.format &&
            file.startedAt === item.startedAt &&
            file.endedAt === item.endedAt &&
            text(file.path) &&
            integer(file.size, 0, Number.MAX_SAFE_INTEGER) &&
            (item.size === null || file.size === item.size) &&
            /^[a-f0-9]{64}$/.test(file.sha256),
        ),
    )
    .map(recordingAssetFingerprint)
}
export async function* syncRecordingArchive(
  catalog: RecordingCatalog,
  input: RecordingSyncOptions,
): AsyncGenerator<RecordingSyncReceipt, void, void> {
  const options = {
    ...input,
    scope: { ...input.scope },
    checkpoint: input.checkpoint ? { ...input.checkpoint } : undefined,
  }
  const windows = recordingWindows(options.from, options.to)
  const selectedScope = scope(options.scope)
  const maxPages = options.maxPages ?? 1000
  const maxEntries = options.maxEntries ?? 10000
  if (
    catalog.provider !== selectedScope.provider ||
    !integer(maxPages, 1, 10000) ||
    !integer(maxEntries, 1, 10000) ||
    typeof options.archive !== "function" ||
    typeof options.now !== "function"
  )
    return fail("invalid archive synchronization configuration")
  if (options.recheckFrom !== undefined) date(options.recheckFrom)
  const checkpoint = options.checkpoint
  if (checkpoint && (!text(checkpoint.jobId) || !text(checkpoint.configKey)))
    return fail("archive checkpoint job and configuration key are required")
  const clock = (): number => {
    const now = options.now()
    if (!integer(now, 0, Number.MAX_SAFE_INTEGER))
      return fail("archive clock must return an epoch millisecond timestamp")
    return now
  }
  clock()
  cancelled(options.signal)
  const lease = checkpoint ? await checkpoint.store.acquire(checkpoint.jobId) : undefined
  try {
    cancelled(options.signal)
    const previous = checkpoint && lease ? await checkpoint.store.read(checkpoint.jobId, lease.token) : null
    let state: RecordingSyncCheckpoint = previous
      ? parseRecordingSyncCheckpoint(previous, maxEntries)
      : {
          version: 1,
          scope: selectedScope,
          configKey: checkpoint?.configKey ?? "ephemeral",
          revision: 0,
          updatedAt: clock(),
          windows: [],
          pendingWindows: [],
          entries: [],
        }
    if (
      state.scope.provider !== selectedScope.provider ||
      state.scope.account !== selectedScope.account ||
      state.configKey !== (checkpoint?.configKey ?? "ephemeral")
    )
      return fail("archive checkpoint belongs to another account or configuration", "configuration_error")
    const save = async (next: RecordingSyncCheckpoint): Promise<void> => {
      const updated = { ...next, revision: state.revision + 1, updatedAt: clock() }
      if (
        !integer(updated.revision, 1, Number.MAX_SAFE_INTEGER) ||
        updated.windows.length > 1000 ||
        updated.pendingWindows.length > 1000 ||
        updated.entries.length > maxEntries ||
        metadataSize(updated) > 8 * 1024 ** 2
      )
        return fail("archive checkpoint exceeds its metadata limit", "invalid_response")
      if (checkpoint && lease)
        await checkpoint.store.save(
          checkpoint.jobId,
          lease.token,
          state.revision === 0 ? null : state.revision,
          updated,
        )
      state = updated
    }
    const backlog = state.entries.filter(pending).map((entry) => entry.window)
    const planned = [
      ...new Map([...state.pendingWindows, ...backlog, ...windows].map((item) => [windowKey(item), item])).values(),
    ].sort((a, b) => a.from.localeCompare(b.from))
    const observed = new Map<string, string>()
    let pages = 0
    let observedBytes = 0
    for (const selectedWindow of planned) {
      cancelled(options.signal)
      if (
        covered(state.windows, selectedWindow) &&
        !state.pendingWindows.some((item) => windowKey(item) === windowKey(selectedWindow)) &&
        !state.entries.some((entry) => windowKey(entry.window) === windowKey(selectedWindow) && pending(entry)) &&
        !(options.recheckFrom !== undefined && selectedWindow.to >= options.recheckFrom)
      )
        continue
      if (!state.pendingWindows.some((item) => windowKey(item) === windowKey(selectedWindow)))
        await save({ ...state, pendingWindows: [...state.pendingWindows, selectedWindow] })
      const cursors = new Set<string>()
      let cursor: string | undefined
      do {
        cancelled(options.signal)
        if (++pages > maxPages) return fail("archive catalog page limit exceeded", "invalid_response")
        const page = await catalog.list({
          ...selectedWindow,
          account: selectedScope.account,
          ...(cursor === undefined ? {} : { cursor }),
          ...(options.signal ? { signal: options.signal } : {}),
        })
        cancelled(options.signal)
        if (
          !Array.isArray(page.items) ||
          page.items.length > 1000 ||
          !(page.nextCursor === null || text(page.nextCursor))
        )
          return fail("provider returned an invalid recording page", "invalid_response")
        for (const raw of page.items) {
          cancelled(options.signal)
          if (!text(raw.id) || !text(raw.externalId) || !nullableText(raw.title) || !nullableText(raw.startedAt))
            return fail("provider returned an invalid recording occurrence", "invalid_response")
          const occurrence = {
            id: raw.id,
            externalId: raw.externalId,
            title: raw.title,
            startedAt: raw.startedAt,
            assets: assets(raw.assets),
          }
          const signature = JSON.stringify(occurrence)
          const earlier = observed.get(occurrence.externalId)
          if (earlier !== undefined) {
            if (earlier !== signature)
              return fail("provider returned conflicting recording occurrences", "invalid_response")
            continue
          }
          observedBytes += new TextEncoder().encode(signature).byteLength
          if (observedBytes > 8 * 1024 ** 2)
            return fail("archive occurrence metadata exceeds its byte limit", "invalid_response")
          if (observed.size >= maxEntries) return fail("archive occurrence limit exceeded", "invalid_response")
          observed.set(occurrence.externalId, signature)
          const old = state.entries.find((entry) => entry.externalId === occurrence.externalId)
          const current: RecordingSyncEntry = {
            externalId: occurrence.externalId,
            window: selectedWindow,
            assets: occurrence.assets,
            acknowledged:
              old?.acknowledged.filter((key) =>
                occurrence.assets.some((item) => recordingAssetFingerprint(item) === key),
              ) ?? [],
          }
          if (old && !pending(current)) continue
          if (!old && state.entries.length >= maxEntries)
            return fail("archive checkpoint entry limit exceeded", "invalid_response")
          const archive = await options.archive(structuredClone(occurrence), options.signal)
          current.acknowledged = [...new Set([...current.acknowledged, ...acknowledgedAssets(occurrence, archive)])]
          await save({
            ...state,
            entries: [...state.entries.filter((entry) => entry.externalId !== current.externalId), current],
          })
          yield {
            window: selectedWindow,
            occurrence: { id: occurrence.id, externalId: occurrence.externalId, title: occurrence.title },
            archive,
            availability: "unknown",
            checkpointRevision: checkpoint ? state.revision : null,
          }
        }
        if (page.nextCursor !== null && cursors.has(page.nextCursor))
          return fail("provider repeated a recording pagination cursor", "invalid_response")
        if (page.nextCursor !== null) cursors.add(page.nextCursor)
        cursor = page.nextCursor ?? undefined
      } while (cursor !== undefined)
      cancelled(options.signal)
      const pendingWindows = state.pendingWindows.filter((item) => windowKey(item) !== windowKey(selectedWindow))
      const retainFrom = options.recheckFrom ?? `${options.to.slice(0, 7)}-01`
      await save({
        ...state,
        windows: compactWindows([...state.windows, selectedWindow], options.from),
        pendingWindows,
        entries: state.entries.filter(
          (entry) =>
            pending(entry) ||
            entry.window.to >= retainFrom ||
            pendingWindows.some((item) => item.from <= entry.window.to && item.to >= entry.window.from),
        ),
      })
    }
  } finally {
    await lease?.release()
  }
}
