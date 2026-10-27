import { defineLogEvents } from "@wirecat/cli-base/standards"
import type { DiagnosticEvent } from "./events.js"

/** Every event cli-core's writers log, with the attribute keys each record carries, as written (snake_case). */
export const CORE_LOG_EVENTS = defineLogEvents([
  { id: "provider.request", meaning: "a request went to the messenger", keys: ["operation"] },
  { id: "provider.response", meaning: "the messenger answered the request, or it failed", keys: ["operation"] },
  { id: "client.warning", meaning: "the client noticed something unexpected and went on", keys: ["code"] },
  {
    id: "cache.answered",
    meaning: "a read was answered from what was kept, without asking the messenger",
    keys: ["operation", "reason"],
  },
  { id: "command.crashed", meaning: "a command failed on a bug; where, never what", keys: ["error_class", "frames"] },
  {
    id: "events.dropped",
    meaning: "the run reached its cap and counted the rest instead of writing them",
    keys: ["dropped", "counts"],
  },
  { id: "send.recorded", meaning: "a write the send guard saw, and how it ended", keys: ["outcome"] },
  { id: "job.start", meaning: "a background job started", keys: ["job"] },
  { id: "job.exit", meaning: "a background job ended", keys: ["job", "outcome"] },
  { id: "schedule.start", meaning: "a scheduled run started", keys: ["schedule", "kind"] },
  { id: "schedule.exit", meaning: "a scheduled run ended", keys: ["schedule", "kind", "exit_code"] },
  { id: "agent.action", meaning: "one MCP tool call, from the agent log", keys: ["tool", "tier", "outcome"] },
  { id: "serve.note", meaning: "serve reports what it is doing", keys: [] },
  { id: "serve.success", meaning: "serve finished something", keys: [] },
  { id: "serve.warning", meaning: "serve went on past a problem", keys: [] },
  { id: "serve.failure", meaning: "serve could not do something", keys: [] },
])

/** An adapter's event names stay short in memory; the log writes them as registered ids. */
export const DIAGNOSTIC_LOG_EVENTS: Record<DiagnosticEvent["event"], string> = {
  request: "provider.request",
  response: "provider.response",
  warning: "client.warning",
  cache: "cache.answered",
}
