import { isoTime, pageSchema } from "@wirecat/cli-base/standards"
import * as v from "valibot"

const count = v.pipe(v.number(), v.integer(), v.minValue(0))
const id = v.pipe(v.string(), v.minLength(1), v.maxLength(1000))
export const meetingSeriesInventory = v.strictObject({
  schema_version: v.literal(1),
  kind: v.literal("meeting_series_inventory"),
  scope: v.strictObject({ provider: id, account: id }),
  after: isoTime,
  until: isoTime,
  items: v.array(
    v.strictObject({
      meeting_id: id,
      title: v.nullable(v.pipe(v.string(), v.maxLength(8192))),
      kind: v.picklist(["single", "recurring", "unscheduled", "unknown"]),
      scheduled_start_at: v.nullable(isoTime),
    }),
  ),
  page: pageSchema,
  fingerprint: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  limits: v.strictObject({ limit: count, max_read_bytes: count, bytes: count }),
  coverage: v.strictObject({
    selection: v.picklist(["provider-window", "provider-inventory"]),
    source_partial: v.boolean(),
    has_more: v.boolean(),
    undated: count,
    date_hints_outside_window: count,
    calendar_completeness: v.literal("unknown"),
    occurrence_proof: v.literal("not-read"),
    consistency: v.literal("live-provider-pages"),
  }),
})
