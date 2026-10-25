import { CliError } from "@wirecat/cli-base"
import { findRun, listRuns, readEvents } from "../../runs/run.js"
import { dateWindow } from "../../services/moment.js"
import { listOf, snakeKeys } from "../envelope.js"

export interface RunSearch {
  query?: string
  terms?: readonly string[]
  status?: "success" | "failed" | "partial" | "running"
  errorCode?: string
  operation?: string
  profile?: string
  since?: string
  until?: string
  limit?: number
  page?: number
}
const FIELDS = [
  "event",
  "operation",
  "opcode",
  "seq",
  "status",
  "method",
  "endpoint_template",
  "bytes",
  "ids",
  "counts",
  "duration_ms",
  "outcome",
  "error_code",
  "provider_error",
  "code",
  "reason",
  "time",
]
const safeEvent = (event: Record<string, unknown>) =>
  Object.fromEntries(
    FIELDS.flatMap<[string, unknown]>((name) => {
      const value = event[name]
      if (value === undefined) return []
      if (name === "ids" || name === "counts") {
        if (!value || typeof value !== "object" || Array.isArray(value)) return []
        const safe = Object.fromEntries(
          Object.entries(value).filter(
            ([key, entry]) =>
              /^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) &&
              (typeof entry === "number" || (typeof entry === "string" && /^[0-9-]+$/.test(entry))),
          ),
        )
        return [[name, safe]]
      }
      return typeof value === "string" || typeof value === "number" ? [[name, value]] : []
    }),
  )

export const searchRuns = (
  dir: string,
  { query = "", terms = [], status, errorCode, operation, profile, since, until, limit = 20, page = 1 }: RunSearch = {},
) => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(page) || page < 1)
    throw new CliError("validation_error", "run search uses a limit from 1 to 100 and a positive page")
  const window = dateWindow({ sinceTime: since, untilTime: until })
  const from = window.since
  if (from !== undefined && !Number.isFinite(from))
    throw new CliError("validation_error", "--since-time must be a valid date or ISO timestamp")
  const needles = [...(query ? [query] : []), ...terms].map((term) => term.toLowerCase())
  const offset = (page - 1) * limit
  const matches = []
  for (const run of listRuns(dir, from === undefined ? {} : { since: from })) {
    if (
      (profile !== undefined && run.profile !== profile) ||
      (status !== undefined && run.status !== status) ||
      (from !== undefined && Date.parse(run.startedAt) < from) ||
      (window.until !== undefined && Date.parse(run.startedAt) > window.until)
    )
      continue
    const metadataMatch =
      (!errorCode ||
        run.errorCode === errorCode ||
        run.partial?.failures.some((failure) => failure.errorCode === errorCode)) &&
      !operation &&
      needles.every((needle) => JSON.stringify(run).toLowerCase().includes(needle))
    // A finished run lists its operations and codes, so a run that cannot match is never opened.
    // One still running, or killed, has no such list and is read.
    const ruledOut =
      !metadataMatch &&
      needles.length === 0 &&
      ((operation !== undefined && run.operations !== undefined && !run.operations.includes(operation)) ||
        (errorCode !== undefined && run.codes !== undefined && !run.codes.includes(errorCode)))
    if (ruledOut) continue
    const found = findRun(dir, run.runId)
    const events = found ? readEvents(found.dir).map(safeEvent) : []
    const filtered = events.filter(
      (event) =>
        (!errorCode || event.error_code === errorCode || event.code === errorCode) &&
        (!operation || event.operation === operation) &&
        needles.every((needle) => JSON.stringify(event).toLowerCase().includes(needle)),
    )
    if (!metadataMatch && filtered.length === 0) continue
    const metadata = {
      runId: run.runId,
      command: run.command,
      profile: run.profile,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      durationMs: run.durationMs,
      requests: run.requests,
      cliVersion: run.cliVersion,
      runtime: run.runtime,
      platform: run.platform,
      arch: run.arch,
      errorCode: run.errorCode,
      providerError: run.providerError,
      ...(run.partial
        ? {
            partial: {
              failed: run.partial.failed,
              stopReason: run.partial.stopReason,
              failures: run.partial.failures.map(({ id, stage, errorCode, attachment }) => ({
                id,
                stage,
                errorCode,
                attachment,
              })),
            },
          }
        : {}),
    }
    matches.push({ ...metadata, events: filtered.slice(0, 100), eventsTruncated: filtered.length > 100 })
    if (matches.length > offset + limit) break
  }
  return {
    items: matches.slice(offset, offset + limit),
    page,
    limit,
    hasMore: matches.length > offset + limit,
    meta: window.meta,
  }
}

/** A page of `searchRuns` in the list envelope; `args` are the search's own, so `page.next` reruns it. */
export const runsFound = (found: ReturnType<typeof searchRuns>, args: Record<string, unknown>) =>
  listOf("search runs", {
    items: found.items.map(snakeKeys),
    limit: found.limit,
    has_more: found.hasMore,
    page: found.page,
    args: Object.fromEntries(Object.entries(args).filter(([name, value]) => value !== undefined && name !== "page")),
    meta: found.meta,
  })
