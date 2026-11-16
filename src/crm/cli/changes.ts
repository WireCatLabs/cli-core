import { CliError } from "@wirecat/cli-base"
import { annotate, annotateOption } from "@wirecat/cli-base/commands"
import { type QueryRegistry, timezoneOf } from "@wirecat/cli-base/query"
import { type Command, Option } from "commander"
import * as v from "valibot"
import { answerEntity } from "../../cli/answer-entity.js"
import { inCommandRun, outputFor } from "../../cli/context.js"
import { LOCAL_READ, NO_EFFECTS } from "../../cli/effects.js"
import { listOf } from "../../cli/envelope.js"
import {
  listQuery,
  nativeField,
  nativeTerms,
  queryTerms,
  termField,
  timeBounds,
  typedQuery,
  withQuery,
} from "../../cli/list-query.js"
import { ownerLanguageOf } from "../../cli/schedule/schedule-command.js"
import { CRM_ACTIVITY_KINDS, CRM_KINDS } from "../../domain/crm.js"
import { text, time } from "../../entities/fields.js"
import type { AppIdentity } from "../../ports/app.js"
import { foldName } from "../../resolve.js"
import { CRM_CHANGES, type CrmChange, type CrmChangeKind } from "../../store/sqlite/crm-changes.js"
import { crmDigest } from "../digest.js"
import { SYNCED_FROM } from "../sync.js"
import { shortened, viewerOf } from "../viewer.js"
import { addCrmActivityCommands } from "./activities.js"
import { csvColumnPaths, printCsv, refuseCsvConflict } from "./csv.js"
import type { CrmRun, CrmWithin } from "./index.js"
import { integer } from "./records.js"

const MOST = 500
const DAY = 86_400_000
const nullableText = v.nullable(text)

export const CHANGES_QUERY = {
  entity: "crm_change",
  backend: "native",
  fields: [
    nativeField({
      name: "at",
      type: "time",
      operators: ["term", "range"],
      example: "at>=1d",
      relation: "when it happened; the last day when left out",
    }),
    termField("change", "enum", "change:won", { values: CRM_CHANGES }),
    termField("owner", "kw", "owner:me", {
      relation: "the CRM user its deal, lead or contact is assigned to: me, none, or the CRM's user id",
    }),
    termField("pipeline", "kw", "pipeline:Sales", { relation: "pipeline:<id>, or a name only one pipeline has" }),
  ],
} as const satisfies QueryRegistry

const crmChange = v.strictObject({
  change: v.picklist(CRM_CHANGES),
  at: time,
  kind: v.picklist(CRM_KINDS),
  ref: nullableText,
  external_id: text,
  account: v.strictObject({ provider: text, account: text }),
  title: nullableText,
  pipeline: nullableText,
  pipeline_name: nullableText,
  from: nullableText,
  to: nullableText,
  amount: nullableText,
  currency: nullableText,
  exact: v.boolean(),
  reason: nullableText,
  owner: nullableText,
  activity: v.nullable(
    v.strictObject({
      external_id: text,
      kind: v.picklist(CRM_ACTIVITY_KINDS),
      subject: text,
      due_at: v.nullable(time),
      done: v.boolean(),
    }),
  ),
  untrusted: v.array(text),
})

const UNTRUSTED = ["title", "from", "to", "pipeline_name", "reason", "activity.subject"]
const CSV_COLUMNS = [
  "change",
  "at",
  "kind",
  "ref",
  "title",
  "from",
  "to",
  "amount",
  "currency",
  "reason",
  "owner",
  "activity.subject",
]

const itemOf = (run: CrmRun, one: CrmChange) => ({
  change: one.change,
  at: new Date(one.at).toISOString(),
  kind: one.kind,
  ref: one.ref,
  external_id: one.externalId,
  account: { provider: run.account.provider, account: run.account.account },
  title: one.title,
  pipeline: one.pipeline,
  pipeline_name: one.pipelineName,
  from: one.from,
  to: one.to,
  amount: one.amount,
  currency: one.currency,
  exact: one.exact,
  reason: one.reason,
  owner: one.owner,
  activity: one.activity && {
    external_id: one.activity.externalId,
    kind: one.activity.kind,
    subject: one.activity.subject,
    due_at: one.activity.dueAt === null ? null : new Date(one.activity.dueAt).toISOString(),
    done: one.activity.done,
  },
  untrusted: UNTRUSTED,
})

/** A page's place in one fixed window, so the next page reads the same rows however the clock or the copy moved. */
interface Position {
  since: number
  until: number
  offset: number
}

const cursorOf = (at: Position) => Buffer.from(JSON.stringify(at)).toString("base64url")

const positionOf = (cursor: string): Position => {
  try {
    const at = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<Position>
    if ([at.since, at.until, at.offset].every((one) => Number.isSafeInteger(one))) return at as Position
  } catch {}
  throw new CliError("validation_error", "--cursor is not one a changes list answer gave", {
    reason: "input.invalid",
  })
}

/** The sync state a scheduled digest keeps the end of its last window in, so the next one starts there. */
const digestState = (schedule: string) => `crm:digest:${schedule}`

export interface CrmChangeCommandOptions {
  within: CrmWithin
  example: (command: Command, ...lines: string[]) => Command
  open: (command: Command, access: { readOnly: boolean }) => Promise<CrmRun>
  app: AppIdentity
  now: () => number
  ownerOf: (run: CrmRun, owner: string) => Promise<string | null>
  pathOf: (command: Command) => string[]
  /** Also mount `activities list`, for a CLI that copies the CRM's activities. */
  activities?: boolean
}

/** `changes list`: what happened in the copy in a window, newest first; `--format report` is the morning digest. */
export const addCrmChangeCommands = (program: Command, options: CrmChangeCommandOptions): void => {
  const { within, example, now, ownerOf, pathOf } = options
  if (options.activities) addCrmActivityCommands(program, { within, example, now, ownerOf, pathOf })
  const group = annotate(program.command("changes"), { effects: NO_EFFECTS }).description(
    "what changed in the CRM's deals, leads, activities and contacts, as the syncs copied it",
  )
  example(
    withQuery(
      answerEntity(annotate(group.command("list"), { effects: LOCAL_READ }), "crm_change", crmChange)
        .description(
          "deals and leads made, moved, won, lost and given another owner, activities added and done, and contacts " +
            "added, newest first; the last day unless at: says otherwise",
        )
        .option("--limit <n>", `changes per page, 1–${MOST}`, integer(MOST), 50)
        .option("--cursor <cursor>", "the next page, as the last answer's page.next gave it")
        .addOption(
          annotateOption(
            new Option(
              "--format <format>",
              "csv: this page as a table; report: the window as a morning digest document, for schedule command. " +
                "Run by a schedule, the report starts where that schedule's last one ended",
            ).choices(["csv", "report"]),
            { mcp: false },
          ),
        ),
      CHANGES_QUERY,
    ),
    'changes list "at>=1d"',
    "changes list change:won at>=7d --json",
    'changes list "at>=1d" --format report',
  ).action(async (words: string[], opts: { limit: number; cursor?: string; format?: "csv" | "report" }, command) => {
    const name = "changes list"
    const terms = queryTerms(words, CHANGES_QUERY, name, ["at"])
    const zone = timezoneOf()
    const clock = now()
    const at = timeBounds(nativeTerms(listQuery(typedQuery(words), CHANGES_QUERY, name), name).get("at"), zone, clock)
    const until = at.until ?? clock
    const position = opts.cursor ? positionOf(opts.cursor) : { since: at.since ?? until - DAY, until, offset: 0 }
    const filterOf = async (run: CrmRun, window: { since: number; until: number }) => ({
      ...window,
      viewer: await viewerOf(run),
      ...(terms.has("change") ? { changes: [terms.get("change") as CrmChangeKind] } : {}),
      ...(terms.has("owner") ? { owner: await ownerOf(run, terms.get("owner") as string) } : {}),
      ...(terms.has("pipeline") ? { pipeline: await pipelineOf(run, terms.get("pipeline") as string) } : {}),
    })
    const read = async (run: CrmRun) => {
      const found = await run.store.crm.changes(run.account, {
        ...(await filterOf(run, position)),
        limit: opts.limit,
        offset: position.offset,
      })
      const next = found.hasMore ? cursorOf({ ...position, offset: position.offset + opts.limit }) : undefined
      return { items: found.items.map((one) => itemOf(run, one)), next }
    }
    const noted = (run: CrmRun) => {
      const note = shortened.get(run)
      if (note) outputFor(command).renderer.note(note)
      return note
    }
    if (opts.format === "report") {
      if (terms.size)
        throw new CliError("validation_error", "--format report takes only at: — the digest covers every change", {
          reason: "query.unsupported-placement",
        })
      const env = { ...process.env }
      const schedule = env[`${options.app.envPrefix}_SCHEDULED`]
      return inCommandRun(command, async () => {
        const run = await options.open(command, { readOnly: schedule === undefined })
        let printed = false
        try {
          const last = schedule && (await run.store.sync.syncState(run.account, digestState(schedule)))?.value
          // A change the CRM made before the last complete sync started is in the copy; a later one may not be yet.
          const synced = Number((await run.store.sync.syncState(run.account, SYNCED_FROM))?.value || Number.NaN)
          const end = Math.min(last ? clock : position.until, Number.isNaN(synced) ? clock : synced)
          const since = last ? Number(last) + 1 : position.since
          const window = { since, until: Math.max(since, end) }
          const document = await crmDigest(run.store, run.account, {
            ...window,
            now: clock,
            zone,
            language: await ownerLanguageOf(run.env ?? env),
            profile: run.profile,
            viewer: await viewerOf(run),
            ...(shortened.has(run) ? { hidden: true } : {}),
          })
          outputFor(command).streams.data(`${JSON.stringify(document)}\n`)
          noted(run)
          // Moved only once the report is out, so a run that fails before then shows its window next time.
          if (schedule)
            await run.store.sync.setSyncState(run.account, digestState(schedule), String(Math.max(since - 1, end)))
          printed = true
        } finally {
          // Once the report is out and its window spent, a failed close must not fail the run: it would go unsent.
          await run.close?.().catch((error: unknown) => {
            if (!printed) throw error
            outputFor(command).renderer.note(`the store did not close cleanly: ${String(error)}`)
          })
        }
      })
    }
    if (opts.format === "csv") {
      refuseCsvConflict(command)
      return inCommandRun(command, async () => {
        const run = await options.open(command, { readOnly: true })
        try {
          const found = await read(run)
          printCsv(
            command,
            { items: found.items, fields: [], page: 1, hasMore: false },
            csvColumnPaths(command, CSV_COLUMNS),
          )
          noted(run)
          if (found.next) outputFor(command).renderer.note(`→ more rows: run it again with --cursor ${found.next}`)
        } finally {
          await run.close?.()
        }
      })
    }
    await within(command, async (run) => {
      const found = await read(run)
      return listOf(pathOf(command).join(" "), {
        items: found.items,
        limit: opts.limit,
        has_more: found.next !== undefined,
        paging: "cursor",
        ...(found.next ? { cursor: found.next } : {}),
        ...(words.length ? { args: { query: words } } : {}),
        meta: {
          timezone: zone,
          window: { since: new Date(position.since).toISOString(), until: new Date(position.until).toISOString() },
        },
      })
    })
  })
}

/** `pipeline:` as a store id: `pipeline:<id>`, or the name only one of the account's pipelines has. */
const pipelineOf = async (run: CrmRun, value: string): Promise<number> => {
  const all = await run.store.deals.pipelines({ account: run.account, viewer: await viewerOf(run) })
  const found = /^pipeline:\d+$/.test(value)
    ? all.filter((one) => one.ref === value)
    : all.filter((one) => foldName(one.name) === foldName(value))
  if (found.length === 1) return Number(found[0]?.id)
  throw found.length
    ? new CliError("validation_error", `more than one pipeline is named ${value}; name one by its reference`, {
        reason: "pipeline.ambiguous",
      })
    : new CliError("not_found", `no pipeline ${value} in this account`, { reason: "pipeline.not-found" })
}
