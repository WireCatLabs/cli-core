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
import { CRM_CHANGES, type CrmChange, type CrmChangeKind } from "../../store/sqlite/crm-changes.js"
import { crmDigest } from "../digest.js"
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
const CSV_COLUMNS = ["change", "at", "kind", "ref", "title", "from", "to", "amount", "currency", "owner"]

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

export interface CrmChangeCommandOptions {
  within: CrmWithin
  example: (command: Command, ...lines: string[]) => Command
  open: (command: Command, access: { readOnly: boolean }) => Promise<CrmRun>
  now: () => number
  ownerOf: (run: CrmRun, owner: string) => Promise<string | null>
  pathOf: (command: Command) => string[]
}

/** `changes list`: what happened in the copy in a window, newest first; `--format report` is the morning digest. */
export const addCrmChangeCommands = (program: Command, options: CrmChangeCommandOptions): void => {
  const { within, example, now, ownerOf, pathOf } = options
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
        .option("--page <n>", "which page, starting at 1", integer(1_000_000), 1)
        .addOption(
          annotateOption(
            new Option(
              "--format <format>",
              "csv: this page as a table; report: the window as a morning digest document, for schedule command",
            ).choices(["csv", "report"]),
            { mcp: false },
          ),
        ),
      CHANGES_QUERY,
    ),
    'changes list "at>=1d"',
    "changes list change:won at>=7d --json",
    'changes list "at>=1d" --format report',
  ).action(async (words: string[], opts: { limit: number; page: number; format?: "csv" | "report" }, command) => {
    const name = "changes list"
    const terms = queryTerms(words, CHANGES_QUERY, name, ["at"])
    const zone = timezoneOf()
    const at = timeBounds(nativeTerms(listQuery(typedQuery(words), CHANGES_QUERY, name), name).get("at"), zone)
    const until = at.until ?? now()
    const since = at.since ?? until - DAY
    const read = async (run: CrmRun) =>
      run.store.crm.changes(run.account, {
        since,
        until,
        zone,
        ...(terms.has("change") ? { changes: [terms.get("change") as CrmChangeKind] } : {}),
        ...(terms.has("owner") ? { owner: await ownerOf(run, terms.get("owner") as string) } : {}),
        ...(terms.has("pipeline")
          ? {
              pipeline: Number(
                (await run.store.deals.pipeline(terms.get("pipeline") as string, { account: run.account })).id,
              ),
            }
          : {}),
        limit: opts.limit,
        offset: (opts.page - 1) * opts.limit,
      })
    if (opts.format === "report") {
      if (terms.size)
        throw new CliError("validation_error", "--format report takes only at: — the digest covers every change", {
          reason: "query.unsupported-placement",
        })
      return inCommandRun(command, async () => {
        const run = await options.open(command, { readOnly: true })
        let document: Record<string, unknown>
        try {
          document = await crmDigest(run.store, run.account, {
            since,
            until,
            now: now(),
            zone,
            language: await ownerLanguageOf(run.env ?? process.env),
            profile: run.profile,
          })
        } finally {
          await run.close?.()
        }
        outputFor(command).streams.data(`${JSON.stringify(document)}\n`)
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
            { items: found.items.map((one) => itemOf(run, one)), fields: [], page: opts.page, hasMore: found.hasMore },
            csvColumnPaths(command, CSV_COLUMNS),
          )
        } finally {
          await run.close?.()
        }
      })
    }
    await within(command, async (run) => {
      const found = await read(run)
      return listOf(pathOf(command).join(" "), {
        items: found.items.map((one) => itemOf(run, one)),
        limit: opts.limit,
        page: opts.page,
        has_more: found.hasMore,
        ...(words.length ? { args: { query: words } } : {}),
        meta: {
          timezone: zone,
          window: { since: new Date(since).toISOString(), until: new Date(until).toISOString() },
        },
      })
    })
  })
}
