import { isoTime, reference } from "@wirecat/cli-base/standards"
import * as v from "valibot"
import { preparationCount as count, preparationId as id } from "./meeting-preparation-parts.js"

const communicationCoverage = v.strictObject({
  read_usage: v.strictObject({ reads: count, charged_bytes: count, reserved_bytes: count, remaining_bytes: count }),
  query: v.string(),
  window: v.strictObject({ after: isoTime, before: isoTime }),
  selection: v.literal("explicit-host-grants/literal-words"),
  sources: v.array(
    v.strictObject({
      selection_id: id,
      source: v.strictObject({
        kind: v.picklist(["message", "mail", "document"]),
        account_id: id,
        provider: id,
        account: id,
      }),
      state: v.picklist(["searched", "unavailable", "read-limited"]),
      index: v.picklist(["ready", "pending", "missing", "unknown"]),
      has_more: v.boolean(),
      has_undated: v.boolean(),
      completeness: v.literal("unknown"),
      consistency: v.literal("snapshot-per-page"),
      next_cursor: v.nullable(v.string()),
      restart_required: v.boolean(),
      output_limited: v.boolean(),
      read_bytes: v.nullable(count),
      issue: v.nullable(v.picklist(["not_found", "validation_error", "configuration_error"])),
    }),
  ),
})

export const preparationCommunications = v.strictObject({
  coverage: communicationCoverage,
  items: v.array(
    v.strictObject({
      selection_id: id,
      ref: reference,
      provider: id,
      account: id,
      title: v.nullable(v.string()),
      url: v.nullable(v.string()),
      text: v.string(),
      at: isoTime,
      updated_at: isoTime,
      revision: v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
      time_kind: v.picklist(["sent", "source-modified", "stored-update"]),
      text_truncated: v.boolean(),
    }),
  ),
})
