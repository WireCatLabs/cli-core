import { createHash, randomBytes } from "node:crypto"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { Command } from "commander"
import { LOG_ATTRIBUTES } from "../../runs/log-attributes.js"
import { findRun, listRuns, type RunMetadata, readEvents } from "../../runs/run.js"
import { maskArgv } from "../../runs/run-context.js"
import type { SendEntry } from "../../sends/journal.js"

const RECENT_SENDS = 20

export interface Report<Doctor extends object = Record<string, unknown>> {
  createdAt: string
  /** What `doctor --json` answers — versions, paths, counts and the messenger's own checks. */
  doctor: Doctor
  /** The run the report is about: the one asked for, or the newest that failed. */
  run: { metadata: RunMetadata; events: Record<string, unknown>[] } | null
  /** The newest write attempts — outcomes and ids, never text (`src/sends/journal.ts`). */
  sends: SendEntry[]
}

/** Optional technical context supplied by a consumer; it is redacted with the rest of the report. */
export interface ReportContext {
  createdAt?: never
  doctor?: never
  run?: never
  sends?: never
  version?: string
  runtime?: string
  platform?: string
  arch?: string
  profile?: string | null
}

/** Only these fields of a run event travel; a field added later is left out until it is named here. */
const EVENT_FIELDS = [
  "event",
  "operation",
  "ids",
  "counts",
  "duration_ms",
  "outcome",
  "error_code",
  "provider_error",
  "code",
]

/**
 * **Everything a report holds is already free of content** — the doctor, the run log and the send
 * journal are built that way. Two things are added: every id becomes a label, and the home
 * directory is hidden, since paths name the person's account on this machine.
 */
export const buildReport = <Doctor extends object, Context extends ReportContext = Record<never, never>>({
  doctor,
  runsDir,
  runId,
  command,
  sends,
  now = new Date(),
  home,
  context,
  eventFields = "report",
  program,
}: {
  doctor: Doctor
  runsDir: string
  runId?: string
  /** What to type to list runs, for the error when `runId` names none. */
  command: string
  sends: SendEntry[]
  now?: Date
  home: string | undefined
  context?: Context
  /** Retain allowlisted recorded fields, including time and severity, for an existing consumer contract. */
  eventFields?: "report" | "recorded"
  /** The CLI's program, which tells a flag's value from a command word when the run's words are masked. */
  program?: Command
}): Report<Doctor> & Omit<Context, keyof Report> => {
  const chosen = runId === undefined ? newestFailed(runsDir) : findRun(runsDir, runId)
  if (runId !== undefined && !chosen)
    throw new CliError("not_found", `no run ${runId} — \`${command} runs list\` names them`)

  const label = labeller()
  const account = (doctor as Record<string, unknown>).account as { remembered?: string | null } | undefined
  const report = {
    ...context,
    createdAt: now.toISOString(),
    doctor: {
      ...doctor,
      ...(account?.remembered ? { account: { ...account, remembered: label(account.remembered) } } : {}),
    },
    run: chosen
      ? {
          metadata: maskedRun(chosen.metadata, program),
          events: readEvents(chosen.dir).map(eventOf(label, eventFields)),
        }
      : null,
    sends: sends.slice(-RECENT_SENDS).map((entry) => labelled(entry, label)),
  }
  return JSON.parse(hideHome(JSON.stringify(report), home)) as Report<Doctor> & Omit<Context, keyof Report>
}

// A report leaves the machine, so it masks the typed words as `record_input: false` would.
const maskedRun = (metadata: RunMetadata, program = new Command()): RunMetadata =>
  metadata.argv ? { ...metadata, argv: maskArgv(program, metadata.argv).argv } : metadata

/**
 * Every field of a journal line that names a chat, a message or a write. A send's `operationId` is
 * its `sendId`, so one left raw would undo the other's label.
 */
export const SEND_ID_FIELDS = [
  "chatId",
  "messageId",
  "replyTo",
  "threadId",
  "sendAs",
  "resultChatId",
  "sendId",
  "operationId",
  "parentOperationId",
  "reservation",
] as const satisfies readonly (keyof SendEntry)[]

const labelled = (entry: SendEntry, label: (id: string) => string): SendEntry => {
  const copy: Record<string, unknown> = { ...entry }
  for (const field of SEND_ID_FIELDS) {
    const value = copy[field]
    if (value !== undefined && value !== null) copy[field] = label(String(value))
  }
  return copy as unknown as SendEntry
}

export const reportFileName = (app: string, now: Date): string =>
  `${app}-report-${now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")}.json`

/**
 * Inside JSON a Windows home is spelled with doubled backslashes, and a PATH entry keeps whatever
 * case it was typed in, so the match ignores case — hiding a little too much costs nothing here.
 */
const hideHome = (json: string, home: string | undefined): string => {
  if (!home) return json
  const spellings = [JSON.stringify(home).slice(1, -1), home, home.replaceAll("\\", "/")]
  return [...new Set(spellings)].reduce(
    (text, spelling) => text.replace(new RegExp(spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "~"),
    json,
  )
}

/**
 * A report is posted where others read it, and a chat id is somebody's conversation with the owner.
 * Each id becomes a label that is the same everywhere in this report — so a failure can still be
 * followed from request to journal — with **a new salt per report**, so two reports cannot be joined.
 */
const labeller = () => {
  const salt = randomBytes(16)
  return (id: string): string => `id:${createHash("sha256").update(salt).update(id).digest("hex").slice(0, 12)}`
}

const RECORDED_FIELDS = new Set([...LOG_ATTRIBUTES, "time", "severity"])
const RECORDED_ID_FIELDS = new Set([
  ...SEND_ID_FIELDS.map((key) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)),
  "actor_id",
  "target_id",
])

const eventOf =
  (label: (id: string) => string, fields: "report" | "recorded") =>
  (event: Record<string, unknown>): Record<string, unknown> => {
    const kept = Object.fromEntries(
      Object.entries(event)
        .filter(([key]) => (fields === "recorded" ? RECORDED_FIELDS.has(key) : EVENT_FIELDS.includes(key)))
        .map(([key, value]) => [
          key,
          fields === "recorded" && RECORDED_ID_FIELDS.has(key) && value !== undefined && value !== null
            ? label(String(value))
            : value,
        ]),
    )
    const ids = kept.ids
    if (typeof ids !== "object" || ids === null) return kept
    return { ...kept, ids: Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, label(String(id))])) }
  }

const newestFailed = (runsDir: string): { dir: string; metadata: RunMetadata } | undefined => {
  const failed = listRuns(runsDir).find((run) => run.status === "failed")
  return failed ? { dir: join(runsDir, failed.startedAt.slice(0, 10), failed.runId), metadata: failed } : undefined
}
