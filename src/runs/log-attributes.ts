import { logAttributesJsonSchema } from "@wirecat/cli-base/standards"
import type { SendEntry } from "../sends/journal.js"
import type { DiagnosticEvent } from "./events.js"
import { logAttributes } from "./log-keys.js"

type KeysOf<T> = T extends unknown ? keyof T : never

// Records keyed by every field, so a field added to an event or a send entry fails to compile until it is listed here.
const diagnostic: Record<KeysOf<DiagnosticEvent>, true> = {
  event: true,
  operation: true,
  opcode: true,
  seq: true,
  status: true,
  method: true,
  endpointTemplate: true,
  bytes: true,
  ids: true,
  counts: true,
  durationMs: true,
  outcome: true,
  errorCode: true,
  providerError: true,
  code: true,
  detail: true,
  reason: true,
  ageMs: true,
}

const send: Record<Exclude<keyof SendEntry, "at">, true> = {
  profile: true,
  chatId: true,
  outcome: true,
  kind: true,
  action: true,
  people: true,
  messageId: true,
  key: true,
  count: true,
  forEveryone: true,
  sendId: true,
  operationId: true,
  parentOperationId: true,
  replyTo: true,
  threadId: true,
  sendAs: true,
  resultChatId: true,
  length: true,
  attachments: true,
  scheduledFor: true,
  notify: true,
  origin: true,
  reservation: true,
  errorCode: true,
}

/** Background work: a job, a schedule, an agent's tool call. Ids and codes only. */
const background = [
  "job",
  "pid",
  "schedule",
  "exitCode",
  "tool",
  "tier",
  "actorType",
  "actorId",
  "agent",
  "targetType",
  "targetId",
]

/** A crash: where it happened, never what it said. */
const crash = ["errorClass", "frames"]

/**
 * Every attribute key cli-core's writers log, as written: snake_case (`logAttributes`). `createRecordLog`
 * blanks any other, cli-base's own camelCase list included.
 */
export const LOG_ATTRIBUTES: readonly string[] = [
  ...new Set(
    [...Object.keys(diagnostic), ...Object.keys(send), ...background, ...crash].map(
      (key) => Object.keys(logAttributes({ [key]: true }))[0] as string,
    ),
  ),
].sort()

/** For `cli-dev lint --schemas`, under the name `log_attributes`. */
export const logAttributesSchema = (): Record<string, unknown> => logAttributesJsonSchema(LOG_ATTRIBUTES)
