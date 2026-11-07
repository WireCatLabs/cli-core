import { CliError } from "@wirecat/cli-base"
import { annotate, metaOf, sharedCommand } from "@wirecat/cli-base/commands"
import type { QueryRegistry } from "@wirecat/cli-base/query"
import type { NextStep } from "@wirecat/cli-base/standards"
import { Argument, type Command, InvalidArgumentError } from "commander"
import * as v from "valibot"
import { answerEntity } from "../../cli/answer-entity.js"
import { environmentOf, inCommandRun, outputFor, runBudgetOf } from "../../cli/context.js"
import { honoursDryRun } from "../../cli/dry-run-guard.js"
import { FETCH, LOCAL_READ, NO_EFFECTS, REMOTE_WRITE } from "../../cli/effects.js"
import { type Body, itemOf, listOf, renderAnswer, snakeKeys, snakeKeysKeeping } from "../../cli/envelope.js"
import { queryTerms, termField, unfilteredQuery, withQuery } from "../../cli/list-query.js"
import { terminalAsker } from "../../cli/messenger/ask.js"
import { lineOf } from "../../cli/steps.js"
import { CRM_KINDS, type CrmKind } from "../../domain/crm.js"
import { DEAL_KINDS, DEAL_STATUSES, type DealKind } from "../../domain/deals.js"
import { deal as dealEntity } from "../../entities/deal.js"
import { count, text } from "../../entities/fields.js"
import type { AppIdentity } from "../../ports/app.js"
import type { Deal, DealFilter, Pipeline } from "../../store/sqlite/deals.js"
import type { MessageStore } from "../../store/store.js"
import type { AccountKey } from "../../store/types.js"
import type { CrmSource } from "../source.js"
import { crmStatus, syncCrm } from "../sync.js"
import type { CrmWriteCapabilities } from "../writer.js"
import {
  type CrmFieldsInput,
  type CrmWriteContext,
  type CrmWrites,
  closeCrmItem,
  createCrmItem,
  fieldPairsOf,
  moveCrmItem,
  removeCrmItem,
  updateCrmItem,
} from "../writes.js"
import { addCrmSearchAll } from "./search-all.js"

/**
 * The selected profile's CRM account, opened by the app for one command and closed once its answer is built, before
 * anything is printed (WC-LIFE-4).
 */
export interface CrmRun {
  /** The profile's name, which `store status` gives as each sync's `profile`. */
  profile: string
  /** The profile's CRM account as the shared store names it: every command reads and syncs only it. */
  account: AccountKey
  store: MessageStore
  /** The CRM, built on first use: a command that only reads the store never reads the sign-in. */
  source: () => CrmSource
  /** A profile lock pins the process (WC-ACCT-5): `search all` then reads only this account's deals. */
  locked?: boolean
  /** The CRM's writer and the profile's levels, built on first use; needed by every write command. */
  writes?: () => CrmWrites
  env?: NodeJS.ProcessEnv
  close?: () => Promise<void>
}

export interface CrmCommandOptions {
  /** The CLI itself: the first word of examples, and `search all`. */
  app: AppIdentity
  /** Opens the selected profile for one command; `readOnly` when the command only reads the store. */
  open: (command: Command, access: { readOnly: boolean }) => Promise<CrmRun>
  /** The CRM has leads: mounts `leads list|show`. True when absent. */
  leads?: boolean
  /** The writer's capabilities: mounts `create`, `update`, `move`, `close` and `delete` of each kind it writes. */
  writes?: CrmWriteCapabilities
  now?: () => number
}

const MOST = 500

const DEAL_FIELDS = [
  termField("status", "enum", "status:open", { values: DEAL_STATUSES }),
  termField("stage", "kw", 'stage:"Quote sent"', { relation: "a stage's name, in any letter case" }),
  termField("pipeline", "kw", "pipeline:Sales", { relation: "pipeline:<id>, or a name only one pipeline has" }),
  termField("organization", "ref", 'organization:"organization:3"'),
]

/** What `deals list` and `leads list` narrow by, the same in memo and every CRM CLI (WC-OUT-11). */
export const DEALS_QUERY = { entity: "deal", backend: "native", fields: DEAL_FIELDS } as const satisfies QueryRegistry
export const LEADS_QUERY = { entity: "lead", backend: "native", fields: DEAL_FIELDS } as const satisfies QueryRegistry
export const PIPELINES_QUERY = {
  entity: "pipeline",
  backend: "native",
  fields: [termField("kind", "enum", "kind:lead", { values: DEAL_KINDS })],
} as const satisfies QueryRegistry
export const STAGES_QUERY = {
  entity: "stage",
  backend: "native",
  fields: [
    termField("kind", "enum", "kind:deal", { values: DEAL_KINDS }),
    termField("pipeline", "kw", "pipeline:Sales", { relation: "pipeline:<id>, or a name only one pipeline has" }),
  ],
} as const satisfies QueryRegistry

/** A CRM's users typed these; a list item names its own, as `events list` does. */
const DEAL_UNTRUSTED = [
  "title",
  "summary",
  "stage",
  "pipeline_name",
  "organization.name",
  "people.name",
  "provider_metadata",
]
const PIPELINE_UNTRUSTED = ["name", "stages.name"]
const STAGE_UNTRUSTED = ["name", "pipeline_name"]

const crmSync = v.strictObject({
  provider: text,
  account: text,
  pipelines: count,
  users: v.optional(count),
  skipped_owner_rejected: count,
  synced: v.array(
    v.strictObject({
      kind: v.picklist(CRM_KINDS),
      round: v.picklist(["full", "changes"]),
      reset: v.boolean(),
      state: v.picklist(["partial", "complete"]),
      saved: count,
      removed: count,
      unlisted: count,
      pass: v.optional(v.picklist(["complete", "partial", "held"])),
      error: v.optional(text),
    }),
  ),
  issues: v.array(
    v.strictObject({
      kind: v.picklist([...CRM_KINDS, "user"]),
      reason: text,
      message: text,
      external_id: v.optional(text),
    }),
  ),
  complete: v.boolean(),
  state: v.picklist(["partial", "complete"]),
  stopped: v.optional(v.picklist(["requests", "deadline", "cancelled"])),
  progress: v.strictObject({ requests: count, saved: count, steps: count }),
  hint: v.optional(text),
})

const crmSyncProgress = v.strictObject({
  kind: v.picklist(CRM_KINDS),
  round: v.nullable(v.picklist(["full", "changes"])),
  id_pass: v.nullable(text),
  stored: count,
  job: text,
  profile: text,
  done: count,
  total: v.nullable(count),
  remaining: v.nullable(count),
  state: v.picklist(["partial", "complete"]),
  updated_at: v.nullable(text),
  cursor_age_ms: v.nullable(count),
  line: text,
})

const crmWrite = v.strictObject({
  operation_id: text,
  deal: v.optional(dealEntity),
  lead: v.optional(dealEntity),
  untrusted: v.array(text),
})

/** b24's `fields list` answer, so a CRM CLI's own command can go; `untrusted` names what the CRM's users typed. */
const crmField = v.strictObject({
  code: v.string(),
  label: v.nullable(v.string()),
  type: v.string(),
  multiple: v.boolean(),
  filterable: v.boolean(),
  options: v.optional(v.array(v.strictObject({ id: v.string(), label: v.string() }))),
  untrusted: v.array(text),
})
const FIELDS_QUERY = unfilteredQuery("crm_field", crmField)
const FIELD_UNTRUSTED = ["label", "options.label"]
/** The words `fields list` takes: its sibling commands' nouns. */
const FIELD_KINDS: Record<string, CrmKind> = {
  deals: "deal",
  leads: "lead",
  people: "person",
  organizations: "organization",
}

const crmRemoval = v.strictObject({ operation_id: text, ref: text, removed: count })

const collect = (value: string, previous: string[] = []) => {
  if (value.indexOf("=") < 1) throw new InvalidArgumentError("expected key=value")
  return [...previous, value]
}

const integer = (most: number) => (value: string) => {
  if (!/^[1-9]\d*$/.test(value) || Number(value) > most) throw new InvalidArgumentError(`expected 1 to ${most}`)
  return Number(value)
}

/** The words below the program, as `page.next` and `sync`'s next step run it again. */
const pathOf = (command: Command): string[] =>
  command.parent?.parent ? [...pathOf(command.parent), command.name()] : [command.name()]

/** A CRM's own field codes are its keys, never ours to rename. */
const dealKeys = snakeKeysKeeping(["providerMetadata"])

const marked = <T extends object>(items: T[], untrusted: string[]) =>
  items.map((item) => ({ ...(dealKeys(item) as object), untrusted }))

export type CrmWithin = (command: Command, work: (run: CrmRun) => Promise<Body>) => Promise<void>

const addCrmCommandsDefinition = (program: Command, options: CrmCommandOptions): void => {
  const now = () => options.now?.() ?? Date.now()
  const within: CrmWithin = (command, work) =>
    inCommandRun(command, async () => {
      const run = await options.open(command, { readOnly: metaOf(command).effects?.local !== "write" })
      let body: Body
      try {
        body = await work(run)
      } finally {
        await run.close?.()
      }
      renderAnswer(command, outputFor(command), body)
    })
  const example = (command: Command, ...lines: string[]) =>
    annotate(command, { examples: lines.map((line) => `${options.app.command} work ${line}`) })

  example(
    answerEntity(
      annotate(program.command("sync"), { effects: FETCH, offline: false, cooperative: true, partial: true }),
      "crm_sync",
      crmSync,
    ).description(
      "bring the CRM's copy in the local store up to date: pipelines, companies, contacts, deals and leads that " +
        "changed since the last sync, or everything with --rescan; a run stops before its deadline or --max-pages " +
        "and the next one goes on from there",
    ),
    "sync",
    "sync --rescan",
    "sync --max-pages 20",
  )
    .option("--rescan", "list everything again, every id too, dropping a round in progress")
    .option("--max-pages <pages>", "at most this many requests to the CRM in this run", integer(100_000))
    .action(async (opts: { maxPages?: number; rescan?: boolean }, command: Command) => {
      const { signal } = environmentOf(command)
      await within(command, async (run) => {
        const report = await syncCrm(run.source(), run.store, run.account, {
          now: now(),
          budget: runBudgetOf(command, opts.maxPages),
          ...(signal ? { signal } : {}),
          ...(opts.rescan ? { rescan: true } : {}),
        })
        const failed = report.synced.filter((one) => one.error !== undefined)
        const timeout = command.optsWithGlobals<{ timeout?: string }>().timeout
        // The same command again, never --rescan: that would drop the round this run leaves in progress.
        const stuck = report.state === "partial" && report.progress.steps === 0 && failed.length === 0
        const next: NextStep[] | undefined =
          failed.length || (report.state === "partial" && !stuck)
            ? [
                {
                  kind: "command",
                  step: "crm.sync",
                  command: "sync",
                  args: Object.fromEntries(
                    Object.entries({ max_pages: opts.maxPages, timeout }).filter(([, value]) => value !== undefined),
                  ),
                  why: failed.length
                    ? "a kind failed to sync; running sync again retries it"
                    : "the sync stopped before its end to answer in time; running it again goes on from there",
                  safe_to_auto_execute: true,
                },
              ]
            : undefined
        const progressAt = lineOf(command, "store status")
        const hint = failed.length
          ? `${failed.map((one) => `${one.kind}: ${one.error}`).join("; ")} — run sync again to retry`
          : stuck
            ? `this run moved nothing on: raise --timeout or --max-pages, then run sync again; see progress: ${progressAt}`
            : report.state === "partial"
              ? `run sync again to continue; see progress: ${progressAt}`
              : undefined
        const { hint: _hint, ...rest } = report
        // What the healthy kinds brought is saved and answered; each failure and each item not kept is an issue.
        const issues = [
          ...failed.map((one) => ({
            code: "provider_error" as const,
            reason: "sync.partial",
            source: `crm:${one.kind}`,
          })),
          ...report.issues.map((one) => ({
            code: "validation_error" as const,
            reason: one.reason,
            source: one.externalId === undefined ? `crm:${one.kind}` : `crm:${one.kind}/${one.externalId}`,
          })),
        ]
        const partial = report.state === "partial" || issues.length > 0
        return itemOf(snakeKeys({ ...rest, ...(hint === undefined ? {} : { hint }) }), {
          ...(partial ? { meta: { complete: false, ...(issues.length ? { issues } : {}) } } : {}),
          ...(next ? { next } : {}),
        })
      })
    })

  const store = annotate(program.command("store").description("the local copy of the CRM"), { effects: NO_EFFECTS })
  example(
    answerEntity(
      annotate(store.command("status"), { effects: LOCAL_READ }),
      "crm_sync_progress",
      crmSyncProgress,
    ).description(
      "how far each kind's sync is: rows saved, partial or complete, when it last moved, how many are stored",
    ),
    "store status --json",
  ).action(async (_opts: unknown, command: Command) => {
    await within(command, async (run) => {
      const status = await crmStatus(run.store, run.account, { profile: run.profile, now: now() })
      return listOf(pathOf(command).join(" "), {
        items: status.items,
        limit: status.limit,
        has_more: false,
        page: 1,
      })
    })
  })

  const items = (kind: DealKind) => {
    const plural = `${kind}s`
    const query = kind === "deal" ? DEALS_QUERY : LEADS_QUERY
    const group = annotate(program.command(plural), { effects: NO_EFFECTS }).description(
      kind === "deal"
        ? "the CRM's deals as last synced: stage, status, amount and the people on them"
        : "the CRM's leads as last synced",
    )
    example(
      withQuery(
        annotate(group.command("list"), { effects: LOCAL_READ, output: { entity: kind } }).description(
          `${plural} copied from the CRM, newest first; run sync to bring them up to date`,
        ),
        query,
      )
        .option("--limit <n>", `${plural} per page, 1–${MOST}`, integer(MOST), 50)
        .option("--page <n>", "which page, starting at 1", integer(1_000_000), 1),
      `${plural} list status:open --json`,
      `${plural} list stage:"Quote sent"`,
    ).action(async (words: string[], opts: { limit: number; page: number }, command: Command) => {
      const terms = queryTerms(words, query, `${plural} list`)
      await within(command, async (run) => {
        const filter: DealFilter = {
          kind,
          account: run.account,
          ...(terms.has("status") ? { status: terms.get("status") as DealFilter["status"] } : {}),
          ...(terms.has("stage") ? { stage: terms.get("stage") as string } : {}),
          ...(terms.has("pipeline") ? { pipeline: terms.get("pipeline") as string } : {}),
          ...(terms.has("organization") ? { organization: terms.get("organization") as string } : {}),
        }
        const found = await run.store.deals.list({
          ...filter,
          limit: Math.min(opts.limit + 1, MOST),
          offset: (opts.page - 1) * opts.limit,
        })
        return listOf(pathOf(command).join(" "), {
          items: marked(found.slice(0, opts.limit), DEAL_UNTRUSTED),
          limit: opts.limit,
          page: opts.page,
          has_more: found.length > opts.limit,
          ...(words.length ? { args: { query: words } } : {}),
        })
      })
    })
    example(
      annotate(group.command("show"), { effects: LOCAL_READ, output: { entity: kind } })
        .description(`one ${kind} with its pipeline, stage, status, amount and the people on it`)
        .argument("<ref>", `${kind}:<id>, as a list shows it`),
      `${plural} show ${kind}:12`,
    ).action(async (reference: string, _opts: unknown, command: Command) => {
      await within(command, async (run) => {
        const found = await ownCopy(run, kind, reference)
        return itemOf({ ...(dealKeys(found) as object), untrusted: DEAL_UNTRUSTED })
      })
    })
    addWrites(group, kind)
  }

  /** A row of this profile's account: another account's copy, or the owner's own, is not found here. */
  const ownCopy = async (run: CrmRun, kind: DealKind, reference: string): Promise<Deal> => {
    if (!reference.startsWith(`${kind}:`))
      throw new CliError("validation_error", `${kind}s show takes a ${kind}:<id> reference, as a list shows it`, {
        reason: "ref.malformed",
      })
    const found = await run.store.deals.get(reference)
    if (found.account?.provider !== run.account.provider || found.account.account !== run.account.account)
      throw new CliError("not_found", `${reference} is not a copy from this profile's CRM account`)
    return found
  }

  const writes = options.writes
  const addWrites = (group: Command, kind: DealKind) => {
    if (!writes?.kinds.includes(kind)) return
    const plural = `${kind}s`
    const contextOf = (run: CrmRun, command: Command): CrmWriteContext => {
      if (!run.writes) throw new CliError("configuration_error", "this profile cannot write to its CRM")
      return {
        store: run.store,
        account: run.account,
        writes: run.writes(),
        ask: terminalAsker(command),
        source: run.source,
        names: { id: "--operation-id" },
      }
    }
    const answered = (operationId: string, item: Deal) =>
      itemOf({
        operation_id: operationId,
        [kind]: { ...(dealKeys(item) as object), untrusted: DEAL_UNTRUSTED },
        untrusted: DEAL_UNTRUSTED.map((field) => `${kind}.${field}`),
      })
    const write = (name: string, verb: (typeof writes.verbs)[number], description: string) => {
      if (!writes.verbs.includes(verb)) return undefined
      const command = answerEntity(
        annotate(group.command(name), { effects: REMOTE_WRITE, offline: false }),
        verb === "remove" ? "crm_removal" : "crm_write",
        verb === "remove" ? crmRemoval : crmWrite,
      ).description(description)
      if (writes.idempotent)
        command.option(
          "--operation-id <id>",
          "the operation_id a write that ended in outcome_unknown named: the CRM answers the repeat from its record",
        )
      return command
    }
    const reference = (command: Command) => command.argument("<ref>", `${kind}:<id>, as a list shows it`)
    const fields = (command: Command) =>
      command
        .option("--title <title>", `the ${kind}'s title`)
        .option("--pipeline <pipeline>", "pipeline:<id>, or a name only one of the CRM's pipelines has")
        .option(
          "--stage <stage>",
          "a stage of its pipeline, by the CRM's id or name; checks the move key too, and the close key for a won or lost stage",
        )
        .option("--amount <decimal>", "the expected sum, such as 1500.50, with --currency")
        .option("--currency <code>", "an ISO 4217 code, such as EUR")
        .option("--close-date <date>", "the day it is expected to close, YYYY-MM-DD")
        .option(
          "--owner <user>",
          "the CRM user it is assigned to; anyone but the sign-in's own user checks crm.assign-others",
        )
        .option(
          "--field <key=value>",
          "one of the CRM's own fields, by its code or label as `fields list` prints them, and its value; a list " +
            "field takes its option's label or id; repeat it for more fields, or for each value of a multiple field; " +
            "an empty value clears it",
          collect,
          // The empty default marks the flag as repeatable, so an agent's tool takes a list.
          [] as string[],
        )
    type Typed = Omit<CrmFieldsInput, "custom"> & { field?: string[]; operationId?: string }
    const inputOf = ({ field, operationId: _id, ...rest }: Typed): CrmFieldsInput => ({
      ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
      ...(field?.length ? { custom: fieldPairsOf(field) } : {}),
    })
    const idOf = (opts: { operationId?: string }) =>
      opts.operationId === undefined ? {} : { operationId: opts.operationId }
    const run = (command: Command, work: (context: CrmWriteContext) => Promise<Body>) =>
      within(command, (opened) => work(contextOf(opened, command)))

    const create = write("create", "create", `make a ${kind} in the CRM, then store the CRM's copy of it`)
    if (create)
      example(
        fields(create),
        `${plural} create --title "Example kitchen" --amount 15000 --currency EUR`,
        `${plural} create --title "Example office" --pipeline Sales --stage "Quote sent" --field UF_CRM_SOURCE=web`,
      ).action(async (opts: Typed, command: Command) => {
        await run(command, async (context) => {
          const done = await createCrmItem(context, kind, inputOf(opts), idOf(opts))
          return answered(done.operationId, done.item)
        })
      })
    const update = write(
      "update",
      "update",
      `change a ${kind} in the CRM; what is left out keeps its value; the CRM's copy is stored again`,
    )
    if (update)
      example(
        fields(reference(update)),
        `${plural} update ${kind}:12 --amount 18000`,
        `${plural} update ${kind}:12 --field UF_CRM_SOURCE=`,
      ).action(async (ref: string, opts: Typed, command: Command) => {
        await run(command, async (context) => {
          const done = await updateCrmItem(context, kind, ref, inputOf(opts), idOf(opts))
          return answered(done.operationId, done.item)
        })
      })
    const move = write(
      "move",
      "move",
      `move a ${kind} to another stage of its pipeline; a won or lost stage checks the close key too`,
    )
    if (move)
      example(
        reference(move).argument("<stage>", "the stage, by the CRM's id or a name only one stage of its pipeline has"),
        `${plural} move ${kind}:12 "Quote sent"`,
      ).action(async (ref: string, stage: string, opts: { operationId?: string }, command: Command) => {
        await run(command, async (context) => {
          const done = await moveCrmItem(context, kind, ref, stage, idOf(opts))
          return answered(done.operationId, done.item)
        })
      })
    const close = write("close", "close", `mark a ${kind} won or lost, the CRM's own way`)
    if (close)
      example(
        reference(close)
          .addArgument(new Argument("<outcome>", "how it ended").choices(["won", "lost"]))
          .option("--reason <text>", "why, in a few words; kept with it"),
        `${plural} close ${kind}:12 won`,
        `${plural} close ${kind}:12 lost --reason "Example: chose another supplier"`,
      ).action(
        async (
          ref: string,
          outcome: "won" | "lost",
          opts: { reason?: string; operationId?: string },
          command: Command,
        ) => {
          await run(command, async (context) => {
            const done = await closeCrmItem(context, kind, ref, outcome, {
              ...idOf(opts),
              ...(opts.reason === undefined ? {} : { reason: opts.reason }),
            })
            return answered(done.operationId, done.item)
          })
        },
      )
    const remove = write("delete", "remove", `delete a ${kind} in the CRM; asks first unless allowed`)
    if (remove)
      example(reference(remove), `${plural} delete ${kind}:12`).action(
        async (ref: string, opts: { operationId?: string }, command: Command) => {
          await run(command, async (context) => {
            const done = await removeCrmItem(context, kind, ref, idOf(opts))
            return itemOf({ operation_id: done.operationId, ref: done.ref, removed: done.removed })
          })
        },
      )
  }

  items("deal")
  if (options.leads !== false) items("lead")

  const pipelines = annotate(program.command("pipelines"), { effects: NO_EFFECTS }).description(
    "the CRM's pipelines and their stages, as last synced",
  )
  example(
    withQuery(
      annotate(pipelines.command("list"), { effects: LOCAL_READ, output: { entity: "pipeline" } }).description(
        "pipelines copied from the CRM, with their stages in order and how many are open in each",
      ),
      PIPELINES_QUERY,
    ),
    "pipelines list --json",
    "pipelines list kind:lead",
  ).action(async (words: string[], _opts: unknown, command: Command) => {
    const terms = queryTerms(words, PIPELINES_QUERY, "pipelines list")
    await within(command, async (run) => {
      const found = await run.store.deals.pipelines({
        account: run.account,
        ...(terms.has("kind") ? { kind: terms.get("kind") as DealKind } : {}),
      })
      return listOf(pathOf(command).join(" "), {
        items: marked(found, PIPELINE_UNTRUSTED),
        limit: Math.max(1, found.length),
        page: 1,
        has_more: false,
        ...(words.length ? { args: { query: words } } : {}),
      })
    })
  })
  example(
    annotate(pipelines.command("show"), { effects: LOCAL_READ, output: { entity: "pipeline" } })
      .description("one pipeline with its funnel: how many reached each stage, how many went on, and the win rate")
      .argument("<pipeline>", "pipeline:<id>, or a name only one of the CRM's pipelines has"),
    "pipelines show pipeline:3",
  ).action(async (reference: string, _opts: unknown, command: Command) => {
    await within(command, async (run) => {
      const report = await run.store.deals.pipeline(reference, { account: run.account })
      return itemOf({ ...(snakeKeys(report) as object), untrusted: PIPELINE_UNTRUSTED })
    })
  })

  const stages = annotate(program.command("stages"), { effects: NO_EFFECTS }).description(
    "the stages of the CRM's pipelines, as last synced",
  )
  example(
    withQuery(
      annotate(stages.command("list"), { effects: LOCAL_READ, output: { entity: "stage" } }).description(
        "every stage of the CRM's pipelines in order, with its outcome and how many are open in it",
      ),
      STAGES_QUERY,
    ),
    "stages list --json",
    "stages list kind:lead",
  ).action(async (words: string[], _opts: unknown, command: Command) => {
    const terms = queryTerms(words, STAGES_QUERY, "stages list")
    await within(command, async (run) => {
      const kind = terms.has("kind") ? (terms.get("kind") as DealKind) : undefined
      const all = await run.store.deals.pipelines({ account: run.account, ...(kind ? { kind } : {}) })
      const chosen: Pipeline[] = terms.has("pipeline")
        ? [
            await run.store.deals.pipeline(terms.get("pipeline") as string, {
              account: run.account,
              ...(kind ? { kind } : {}),
            }),
          ]
        : all
      const found = chosen.flatMap((pipeline) =>
        pipeline.stages.map(({ name, position, outcome, externalId, open }) => ({
          name,
          position,
          outcome,
          externalId,
          open,
          pipeline: pipeline.ref,
          pipelineName: pipeline.name,
          kind: pipeline.kind,
        })),
      )
      return listOf(pathOf(command).join(" "), {
        items: marked(found, STAGE_UNTRUSTED),
        limit: Math.max(1, found.length),
        page: 1,
        has_more: false,
        ...(words.length ? { args: { query: words } } : {}),
      })
    })
  })

  const fieldKinds = Object.keys(FIELD_KINDS).filter((word) => word !== "leads" || options.leads !== false)
  const fields = annotate(program.command("fields"), { effects: NO_EFFECTS }).description(
    "the CRM's own fields on deals, leads, people and organizations, as last synced",
  )
  example(
    withQuery(
      answerEntity(annotate(fields.command("list"), { effects: LOCAL_READ }), "crm_field", crmField)
        .description("the CRM's custom fields of one kind, in its order, with a list field's options")
        .argument("<kind>", fieldKinds.join(", "))
        .option("--limit <n>", `fields per page, 1–${MOST}`, integer(MOST), 50)
        // No default: the run's settings refuse --all beside a --page, given or defaulted.
        .option("--page <n>", "which page, starting at 1", integer(1_000_000))
        .option("--all", "every field, no paging"),
      FIELDS_QUERY,
    ),
    "fields list deals",
    "fields list people --json",
  ).action(
    async (kind: string, words: string[], opts: { limit: number; page?: number; all?: boolean }, command: Command) => {
      if (!fieldKinds.includes(kind))
        throw new CliError("validation_error", `fields are listed for ${fieldKinds.join(", ")}; got ${kind}`, {
          reason: "field.unknown-kind",
          allowed: fieldKinds,
        })
      queryTerms(words, FIELDS_QUERY, "fields list")
      await within(command, async (run) => {
        const found = await run.store.crm.fields(run.account, FIELD_KINDS[kind] as CrmKind)
        const page = opts.page ?? 1
        const offset = opts.all ? 0 : (page - 1) * opts.limit
        const end = opts.all ? found.length : offset + opts.limit
        return listOf(pathOf(command).join(" "), {
          items: found.slice(offset, end).map((field) => ({ ...field, untrusted: FIELD_UNTRUSTED })),
          limit: opts.all ? Math.max(1, found.length) : opts.limit,
          page,
          has_more: found.length > end,
          ...(words.length ? { args: { query: words } } : {}),
        })
      })
    },
  )

  const search =
    program.commands.find((one) => one.name() === "search") ??
    annotate(program.command("search"), { effects: NO_EFFECTS }).description("search what the local store holds")
  addCrmSearchAll(search, { within, app: options.app, example })
}

// honoursDryRun: a host program other than `run` would otherwise let a write through under --dry-run.
export const addCrmCommands = honoursDryRun(sharedCommand(addCrmCommandsDefinition))
