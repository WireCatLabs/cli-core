import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import type { MeetingProviderScope } from "./provider.js"
import type { MeetingSeriesInventoryPage, MeetingSeriesInventoryRequest } from "./series-inventory-types.js"
import { occurrenceId, occurrenceTime } from "./upcoming-validation.js"

export const inventoryHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
export const inventorySize = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8")
function invalid(field: string, response = false): never {
  throw new CliError(response ? "invalid_response" : "validation_error", `invalid meeting inventory ${field}`)
}
const object = (value: unknown, fields: readonly string[], field: string, response = false) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field, response)
  for (const key of Object.keys(value)) if (!fields.includes(key)) invalid(`${field}.${key}`, response)
}
export const inventoryRequest = (scope: MeetingProviderScope, input: MeetingSeriesInventoryRequest) => {
  object(input, ["after", "until", "limit", "maxReadBytes", "bytes", "cursor", "signal"], "request")
  const { after, until, signal } = input
  if (!occurrenceTime(after) || !occurrenceTime(until) || after >= until || until - after > 366 * 86400000)
    invalid("after/until")
  const limits = { limit: input.limit ?? 100, maxReadBytes: input.maxReadBytes ?? 65536, bytes: input.bytes ?? 65536 }
  for (const [key, value] of Object.entries(limits))
    if (
      !Number.isSafeInteger(value) ||
      value < (key === "bytes" ? 2048 : 1) ||
      value > (key === "limit" ? 100 : 1048576)
    )
      invalid(key)
  if (signal !== undefined && !(signal instanceof AbortSignal)) invalid("signal")
  const selection = inventoryHash({ scope, after, until })
  let cursor: string | undefined
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string" || input.cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(input.cursor))
      invalid("cursor")
    try {
      const decoded: { version: number; selection: string; cursor: string } = JSON.parse(
        Buffer.from(input.cursor, "base64url").toString("utf8"),
      )
      object(decoded, ["version", "selection", "cursor"], "cursor")
      if (decoded.version !== 1 || decoded.selection !== selection || !occurrenceId(decoded.cursor)) invalid("cursor")
      cursor = decoded.cursor
    } catch {
      invalid("cursor")
    }
  }
  return { after, until, limits, signal, selection, cursor }
}
export const inventoryCursor = (selection: string, cursor: string) => {
  const encoded = Buffer.from(JSON.stringify({ version: 1, selection, cursor }), "utf8").toString("base64url")
  if (encoded.length > 4096) invalid("nextCursor budget", true)
  return encoded
}

export const inventoryPage = (
  scope: MeetingProviderScope,
  request: ReturnType<typeof inventoryRequest>,
  page: MeetingSeriesInventoryPage,
) => {
  object(page, ["scope", "after", "until", "items", "nextCursor", "coverage"], "page", true)
  object(page.scope, ["provider", "account"], "scope", true)
  if (
    page.scope.provider !== scope.provider ||
    page.scope.account !== scope.account ||
    page.after !== request.after ||
    page.until !== request.until
  )
    invalid("selection", true)
  object(page.coverage, ["selection", "partial"], "coverage", true)
  if (
    !["provider-window", "provider-inventory"].includes(page.coverage.selection) ||
    typeof page.coverage.partial !== "boolean"
  )
    invalid("coverage", true)
  if (page.nextCursor !== null && (!occurrenceId(page.nextCursor) || page.nextCursor === request.cursor))
    invalid("nextCursor", true)
  if (!Array.isArray(page.items) || page.items.length > request.limits.limit) invalid("items", true)
  const seen = new Set<string>()
  const items = page.items.map((item) => {
    object(item, ["meetingId", "title", "kind", "scheduledStartAt"], "item", true)
    if (!occurrenceId(item.meetingId) || seen.has(item.meetingId)) invalid("meetingId", true)
    seen.add(item.meetingId)
    if (item.title !== null && (typeof item.title !== "string" || item.title.length > 8192)) invalid("title", true)
    if (!["single", "recurring", "unscheduled", "unknown"].includes(item.kind)) invalid("kind", true)
    if (item.scheduledStartAt !== null && !occurrenceTime(item.scheduledStartAt)) invalid("scheduledStartAt", true)
    return { meetingId: item.meetingId, title: item.title, kind: item.kind, scheduledStartAt: item.scheduledStartAt }
  })
  if (inventorySize(page) > request.limits.maxReadBytes) invalid("maxReadBytes budget", true)
  return { items, selection: page.coverage.selection, partial: page.coverage.partial, nextCursor: page.nextCursor }
}
