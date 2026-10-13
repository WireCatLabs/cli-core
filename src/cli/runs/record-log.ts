import { createRecordLog, type Logger } from "@wirecat/cli-base"
import type { AppIdentity } from "../app.js"
import { LOG_ATTRIBUTES } from "./log-attributes.js"
import { currentRun } from "./scope.js"

/** A log writer for the run under way, to a file or a stream, allowing cli-messaging's attribute keys. */
export const recordLogFor = (
  to: string | ((line: string) => void),
  app: AppIdentity,
  { traceId, command }: { traceId?: string; command?: string } = {},
): Logger => {
  const run = currentRun()
  const trace = traceId ?? run.traceId
  return createRecordLog({
    to,
    runId: run.runId,
    command: command ?? run.command,
    ...(trace === undefined ? {} : { traceId: trace }),
    resource: { service: app.command, version: app.version },
    allow: LOG_ATTRIBUTES,
  })
}
