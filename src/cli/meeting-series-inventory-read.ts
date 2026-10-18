import { CliError } from "@wirecat/cli-base"
import { isoTime } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { meetingSeriesInventory } from "../entities/index.js"
import {
  type MeetingSeriesInventoryRequest,
  type MeetingSeriesInventoryResult,
  validateMeetingChange,
  validateMeetingSeriesInventoryCursor,
} from "../meetings/index.js"
import { itemOf, metaNow, sealed, snakeKeys } from "./envelope.js"

export type MeetingSeriesInventoryReader = (
  request: MeetingSeriesInventoryRequest,
) => Promise<MeetingSeriesInventoryResult>
const bounded = (min: number, max: number) =>
  v.optional(v.pipe(v.number(), v.integer(), v.minValue(min), v.maxValue(max)))
export const meetingSeriesInventoryInput = v.strictObject({
  after: v.optional(isoTime),
  until: v.optional(isoTime),
  limit: bounded(1, 100),
  max_read_bytes: bounded(1, 1048576),
  bytes: bounded(2048, 1048576),
  cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(4096), v.regex(/^[A-Za-z0-9_-]+$/))),
})
const MAX_EPOCH_MS = 8_640_000_000_000_000
const storedInstant = (value: number | null) => {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_EPOCH_MS)
    throw new CliError("invalid_response", "meeting inventory scheduled_start_at is invalid")
  return new Date(value).toISOString()
}
const instant = (value: string | undefined, fallback: number, field: string) => {
  if (value === undefined) return fallback
  try {
    return Date.parse(validateMeetingChange({ startTime: value }, false).startTime as string)
  } catch {
    throw new CliError("validation_error", `invalid meeting inventory ${field}`)
  }
}
export const boundMeetingSeriesInventoryItem = (item: { limits: { bytes: number } }) => {
  if (Buffer.byteLength(JSON.stringify(item), "utf8") > item.limits.bytes)
    throw new CliError(
      "validation_error",
      "meeting inventory bytes cannot fit the provider page; increase bytes or lower limit",
    )
}
export const readMeetingSeriesInventory = async (
  read: MeetingSeriesInventoryReader,
  input: unknown,
  signal?: AbortSignal,
  now = Date.now(),
) => {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new CliError("validation_error", "meeting inventory arguments must be an object")
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== null && prototype !== Object.prototype)
    throw new CliError("validation_error", "meeting inventory arguments must be a plain object")
  for (const key of Object.keys(input))
    if (!Object.hasOwn(meetingSeriesInventoryInput.entries, key))
      throw new CliError("validation_error", `unknown meeting inventory argument: ${key}`)
  const parsed = v.safeParse(meetingSeriesInventoryInput, input)
  if (!parsed.success) {
    const field = parsed.issues[0]?.path?.map((part) => String(part.key)).join(".") ?? "arguments"
    throw new CliError("validation_error", `invalid meeting inventory field: ${field}`)
  }
  const args = parsed.output
  if (args.cursor !== undefined) validateMeetingSeriesInventoryCursor(args.cursor)
  const after = instant(args.after, now, "after"),
    until = instant(args.until, after + 7 * 86400000, "until")
  if (!Number.isSafeInteger(after) || !Number.isSafeInteger(until) || after >= until || until - after > 366 * 86400000)
    throw new CliError(
      "validation_error",
      "meeting inventory after/until must form a finite window of at most 366 days",
    )
  signal?.throwIfAborted()
  const packet = await read({
    after,
    until,
    limit: args.limit,
    maxReadBytes: args.max_read_bytes,
    bytes: args.bytes,
    cursor: args.cursor,
    signal,
  })
  signal?.throwIfAborted()
  if (
    !packet ||
    packet.after !== after ||
    packet.until !== until ||
    !Array.isArray(packet.items) ||
    packet.items.length > (args.limit ?? 100) ||
    packet.limits?.bytes !== (args.bytes ?? 65536) ||
    packet.limits.limit !== (args.limit ?? 100) ||
    packet.limits.maxReadBytes !== (args.max_read_bytes ?? 65536) ||
    packet.coverage?.hasMore !== (packet.nextCursor !== null)
  )
    throw new CliError("invalid_response", "meeting inventory returned another selection or exceeded its bounds")
  const { nextCursor, ...body } = packet
  const mapped = snakeKeys({
    ...body,
    after: new Date(after).toISOString(),
    until: new Date(until).toISOString(),
    items: packet.items.map(({ scheduledStartAt, ...item }) => ({
      ...item,
      scheduledStartAt: storedInstant(scheduledStartAt),
    })),
    page: {
      mode: "cursor",
      limit: packet.limits.limit,
      has_more: packet.coverage.hasMore,
      ...(nextCursor === null ? {} : { next_cursor: nextCursor }),
    },
  })
  const checked = v.safeParse(meetingSeriesInventory, mapped)
  if (!checked.success) throw new CliError("invalid_response", "meeting inventory does not match its answer contract")
  const item = checked.output
  boundMeetingSeriesInventoryItem(item)
  return sealed(
    itemOf(item, {
      meta: metaNow({
        complete: !item.coverage.source_partial,
        ...(item.coverage.has_more ? { truncated: true } : {}),
      }),
    }),
  )
}
