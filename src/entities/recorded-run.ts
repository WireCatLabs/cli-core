import * as v from "valibot"
import { count, id, text, time } from "./fields.js"

const events = v.array(v.record(v.string(), v.unknown()))

export const recordedRun = v.strictObject({
  run_id: id,
  command: text,
  profile: v.optional(text),
  started_at: time,
  completed_at: v.optional(time),
  status: v.picklist(["success", "failed", "partial", "running"]),
  requests: v.optional(count),
  duration_ms: v.optional(count),
  cli_version: text,
  runtime: v.optional(text),
  platform: v.optional(text),
  arch: v.optional(text),
  error_code: v.optional(text),
  partial: v.optional(
    v.strictObject({
      failed: count,
      stop_reason: v.optional(text),
      failures: v.array(v.strictObject({ id: text, stage: text, error_code: text, attachment: v.optional(count) })),
    }),
  ),
  provider_error: v.optional(text),
  kept_because_failed: v.optional(v.boolean()),
  operations: v.optional(v.array(text)),
  codes: v.optional(v.array(text)),
  trace_id: v.optional(id),
  cli_command: v.optional(text),
  argv: v.optional(v.array(text)),
  unknown_command: v.optional(text),
  agent: v.optional(
    v.strictObject({
      kind: text,
      session_id: v.nullable(text),
      from_chat: v.optional(v.literal(true)),
      client: v.optional(v.strictObject({ name: text, version: v.optional(text), id: v.optional(text) })),
    }),
  ),
  via: v.optional(v.picklist(["cli", "mcp-stdio", "mcp-http", "desktop"])),
  mcp: v.optional(
    v.strictObject({
      tool: text,
      request_id: v.optional(text),
      connection_id: v.optional(text),
      proxied: v.optional(v.literal(true)),
    }),
  ),
  events_dropped: v.optional(count),
  error: v.optional(
    v.strictObject({
      class: text,
      code: v.optional(text),
      reason: v.optional(text),
      message: v.optional(text),
      operation: v.optional(text),
      http: v.optional(
        v.strictObject({ method: v.optional(text), endpoint_template: v.optional(text), status: v.optional(count) }),
      ),
      provider: v.optional(v.strictObject({ key: v.optional(text), code: v.optional(v.number()) })),
      causes: v.optional(v.array(v.strictObject({ class: text, message: v.optional(text) }))),
      stack: v.optional(v.array(text)),
    }),
  ),
  directory: v.optional(text),
  event_count: v.optional(count),
  events: v.optional(events),
  events_truncated: v.optional(v.boolean()),
})

export const runDetails = v.strictObject({
  ...v.omit(recordedRun, ["events_truncated"]).entries,
  directory: text,
  event_count: count,
  events,
})
export const runHit = v.strictObject({
  ...v.omit(recordedRun, ["directory", "event_count"]).entries,
  events,
  events_truncated: v.boolean(),
})
export const runLocation = v.strictObject({ path: text })
