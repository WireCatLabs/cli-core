import { createHash, randomBytes } from "node:crypto"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import type { SendEntry } from "../../sends/journal.js"
import { findRun, listRuns, type RunMetadata, readEvents } from "../runs/run.js"

const RECENT_SENDS = 20

export interface Report {
  createdAt: string
  /** What `doctor --json` answers — versions, paths, counts and the messenger's own checks. */
  doctor: Record<string, unknown>
  /** The run the report is about: the one asked for, or the newest that failed. */
  run: { metadata: RunMetadata; events: Record<string, unknown>[] } | null
  /** The newest write attempts — outcomes and ids, never text (`src/sends/journal.ts`). */
  sends: SendEntry[]
}

/** Only these fields of a run event travel; a field added later is left out until it is named here. */
const EVENT_FIELDS = [
  "event",
  "operation",
  "ids",
  "counts",
  "durationMs",
  "outcome",
  "errorCode",
  "providerError",
  "code",
]

/**
 * **Everything a report holds is already free of content** — the doctor, the run log and the send
 * journal are built that way. Two things are added: every id becomes a label, and the home
 * directory is hidden, since paths name the person's account on this machine. Copied from max-cli.
 */
export const buildReport = ({
  doctor,
  runsDir,
  runId,
  command,
  sends,
  now = new Date(),
  home,
}: {
  doctor: Record<string, unknown>
  runsDir: string
  runId?: string
  /** What to type to list runs, for the error when `runId` names none. */
  command: string
  sends: SendEntry[]
  now?: Date
  home: string | undefined
}): Report => {
  const chosen = runId === undefined ? newestFailed(runsDir) : findRun(runsDir, runId)
  if (runId !== undefined && !chosen)
    throw new CliError("not_found", `no run ${runId} — \`${command} runs list\` names them`)

  const label = labeller()
  const account = doctor.account as { remembered?: string | null } | undefined
  const report: Report = {
    createdAt: now.toISOString(),
    doctor: {
      ...doctor,
      ...(account?.remembered ? { account: { ...account, remembered: label(account.remembered) } } : {}),
    },
    run: chosen ? { metadata: chosen.metadata, events: readEvents(chosen.dir).map(eventOf(label)) } : null,
    sends: sends.slice(-RECENT_SENDS).map((entry) => labelled(entry, label)),
  }
  return JSON.parse(hideHome(JSON.stringify(report), home)) as Report
}

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

const eventOf =
  (label: (id: string) => string) =>
  (event: Record<string, unknown>): Record<string, unknown> => {
    const kept = Object.fromEntries(Object.entries(event).filter(([key]) => EVENT_FIELDS.includes(key)))
    const ids = kept.ids
    if (typeof ids !== "object" || ids === null) return kept
    return { ...kept, ids: Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, label(String(id))])) }
  }

const newestFailed = (runsDir: string): { dir: string; metadata: RunMetadata } | undefined => {
  const failed = listRuns(runsDir).find((run) => run.status === "failed")
  return failed ? { dir: join(runsDir, failed.startedAt.slice(0, 10), failed.runId), metadata: failed } : undefined
}
