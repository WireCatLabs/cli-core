import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { type QueryRegistry, timezoneOf } from "@wirecat/cli-base/query"
import { Argument, type Command } from "commander"
import * as v from "valibot"
import { answerEntity } from "../../cli/answer-entity.js"
import { LOCAL_READ, NO_EFFECTS, REMOTE_WRITE } from "../../cli/effects.js"
import { type Body, itemOf, listOf } from "../../cli/envelope.js"
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
import { terminalAsker } from "../../cli/messenger/ask.js"
import { CRM_ACTIVITY_KINDS, CRM_KINDS, type CrmActivity, type CrmActivityKind } from "../../domain/crm.js"
import { aheadOf } from "../../domain/moment.js"
import { text, time } from "../../entities/fields.js"
import type { ListedActivity } from "../../store/sqlite/crm-activities.js"
import { crmIdentityId } from "../../store/sqlite/crm-rows.js"
import { crmSettingKey } from "../../store/sqlite/crm-settings.js"
import { viewerOf } from "../viewer.js"
import type { CrmActivityWrite, CrmWriteCapabilities } from "../writer.js"
import { type CrmActivityWritten, type CrmWriteContext, completeCrmActivity, createCrmActivity } from "../writes.js"
import type { CrmRun, CrmWithin } from "./index.js"
import { integer } from "./records.js"

const MOST = 500
const nullableText = v.nullable(text)
const REFS = ["deal", "lead", "person", "organization"] as const

export const ACTIVITIES_QUERY = {
  entity: "crm_activity",
  backend: "native",
  fields: [
    termField("status", "enum", "status:done", { values: ["open", "done"] }),
    nativeField({
      name: "due",
      type: "time",
      operators: ["term", "range"],
      example: "due:today",
      relation: "due in this time",
    }),
    termField("overdue", "bool", "overdue:true", { relation: "open and due before now" }),
    termField("kind", "enum", "kind:call", { values: CRM_ACTIVITY_KINDS }),
    termField("deal", "ref", "deal:12", { relation: "on this deal" }),
    termField("lead", "ref", "lead:4", { relation: "on this lead" }),
    termField("person", "ref", "person:7", { relation: "on this contact" }),
    termField("organization", "ref", "organization:3", { relation: "on this company" }),
    termField("owner", "kw", "owner:me", {
      relation: "the CRM user it is assigned to: me (the sign-in's own), none, or the CRM's user id",
    }),
  ],
} as const satisfies QueryRegistry

const crmActivity = v.strictObject({
  external_id: text,
  kind: v.picklist(CRM_ACTIVITY_KINDS),
  subject: text,
  body: nullableText,
  due_at: v.nullable(time),
  done: v.boolean(),
  done_at: v.nullable(time),
  /** The identity `<account>/user/<id>` responsible for it. */
  assignee: nullableText,
  created_at: time,
  updated_at: time,
  on: v.array(
    v.strictObject({ kind: v.picklist(CRM_KINDS), external_id: text, ref: nullableText, title: nullableText }),
  ),
  untrusted: v.array(text),
})

const UNTRUSTED = ["subject", "body", "on.title"]
const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString())

const listedOf = (one: ListedActivity) => ({
  external_id: one.externalId,
  kind: one.kind,
  subject: one.subject,
  body: one.body,
  due_at: iso(one.dueAt),
  done: one.done,
  done_at: iso(one.doneAt),
  assignee: one.assignee,
  created_at: new Date(one.createdAt).toISOString(),
  updated_at: new Date(one.updatedAt).toISOString(),
  on: one.on.map(({ kind, externalId, ref, title }) => ({ kind, external_id: externalId, ref, title })),
  untrusted: UNTRUSTED,
})

export interface CrmActivityCommandOptions {
  within: CrmWithin
  example: (command: Command, ...lines: string[]) => Command
  now: () => number
  /** `owner:` as the identity an activity's assignee is stored as; `null` is none. */
  ownerOf: (run: CrmRun, owner: string) => Promise<string | null>
  pathOf: (command: Command) => string[]
  /** Mount `activities list`: the CLI copies the CRM's activities. */
  list: boolean
  /** The writer's capabilities: `activities create` and `close` when they name activities. */
  writes?: CrmWriteCapabilities
  /** The CRM has leads; true when absent. */
  leads?: boolean
}

/**
 * `activities list`, mounted when the CLI copies the CRM's activities (WC-ARCH-5), and `activities create` and `close`
 * when its writer makes them.
 */
export const addCrmActivityCommands = (program: Command, options: CrmActivityCommandOptions): void => {
  const group = annotate(program.command("activities"), { effects: NO_EFFECTS }).description(
    options.list
      ? "the CRM's activities and tasks on deals, leads, contacts and companies, as last synced"
      : `comments and tasks written to the CRM's ${options.leads === false ? "deals" : "deals, leads"}, contacts and companies`,
  )
  if (options.list) addList(group, options)
  addActivityWrites(group, options)
}

const addList = (group: Command, options: CrmActivityCommandOptions) => {
  const { within, example, now, ownerOf, pathOf } = options
  example(
    withQuery(
      answerEntity(annotate(group.command("list"), { effects: LOCAL_READ }), "crm_activity", crmActivity)
        .description(
          "activities copied from the CRM, open ones first by due time, then the rest newest first; status:open " +
            "unless a status is given; the activities setting must be on",
        )
        .option("--limit <n>", `activities per page, 1–${MOST}`, integer(MOST), 50)
        .option("--page <n>", "which page, starting at 1", integer(1_000_000), 1),
      ACTIVITIES_QUERY,
    ),
    "activities list overdue:true",
    "activities list due:today --json",
    "activities list deal:12 status:done",
  ).action(async (words: string[], opts: { limit: number; page: number }, command: Command) => {
    const name = "activities list"
    const terms = queryTerms(words, ACTIVITIES_QUERY, name, ["due"])
    const clock = now()
    const due = timeBounds(
      nativeTerms(listQuery(typedQuery(words), ACTIVITIES_QUERY, name), name).get("due"),
      timezoneOf(),
      clock,
    )
    const refs = REFS.filter((kind) => terms.has(kind))
    if (refs.length > 1)
      throw new CliError("validation_error", `name one of ${refs.join(", ")}: an activity list is on one row`, {
        reason: "query.unsupported-placement",
      })
    const ref = refs[0]
    await within(command, async (run) => {
      const paged = { limit: opts.limit, page: opts.page, ...(words.length ? { args: { query: words } } : {}) }
      if (!(await run.store.crm.activitiesOn(run.account)))
        return listOf(pathOf(command).join(" "), {
          items: [],
          ...paged,
          has_more: false,
          missing: [
            {
              field: "activities",
              why: `the activities setting is off: config set ${crmSettingKey(run.account, "activities")} on, then sync`,
            },
          ],
        })
      const found = await run.store.crm.activities(run.account, {
        status:
          (terms.get("status") as "open" | "done" | undefined) ??
          (terms.get("overdue") === "true" ? undefined : "open"),
        ...(due.since === undefined && due.until === undefined
          ? {}
          : {
              due: {
                ...(due.since === undefined ? {} : { since: due.since }),
                ...(due.until === undefined ? {} : { until: due.until }),
              },
            }),
        ...(terms.get("overdue") === "true" ? { overdueAt: clock } : {}),
        viewer: await viewerOf(run),
        ...(terms.has("kind") ? { kinds: [terms.get("kind") as CrmActivityKind] } : {}),
        ...(ref ? { on: refOf(ref, terms.get(ref) as string) } : {}),
        ...(terms.has("owner") ? { owner: await ownerOf(run, terms.get("owner") as string) } : {}),
        limit: opts.limit,
        offset: (opts.page - 1) * opts.limit,
      })
      return listOf(pathOf(command).join(" "), {
        items: found.items.map(listedOf),
        ...paged,
        has_more: found.hasMore,
        ...(due.meta ? { meta: due.meta } : {}),
      })
    })
  })
}

/** `deal:12` as typed, or a bare id for the field it was given to. */
const refOf = (kind: string, value: string) => (value.includes(":") ? value : `${kind}:${value}`)

const writtenActivity = v.strictObject({
  operation_id: text,
  stored: v.boolean(),
  activity: v.omit(crmActivity, ["done_at"]),
  untrusted: v.array(text),
})

/** `activities create` and `activities close`, through the same guarded path as `deals create`. */
const addActivityWrites = (group: Command, options: CrmActivityCommandOptions) => {
  const { within, example, now, writes } = options
  const kinds = writes?.activities ?? []
  if (kinds.length === 0) return
  const leads = options.leads !== false
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
  const answered = (run: CrmRun, done: CrmActivityWritten): Body =>
    itemOf({
      operation_id: done.operationId,
      stored: done.stored,
      activity: writtenOf(run, done.activity, done.on),
      untrusted: UNTRUSTED.map((field) => `activity.${field}`),
    })
  const write = (name: string, description: string) => {
    const command = answerEntity(
      annotate(group.command(name), { effects: REMOTE_WRITE, offline: false }),
      "crm_activity_write",
      writtenActivity,
    ).description(description)
    if (writes?.idempotent)
      command.option(
        "--operation-id <id>",
        "the operation_id a write that ended in outcome_unknown named: the CRM answers the repeat from its record",
      )
    return command
  }
  const idOf = (opts: { operationId?: string }) =>
    opts.operationId === undefined ? {} : { operationId: opts.operationId }
  const comment = kinds.includes("comment")
  const task = kinds.includes("task")

  type Typed = { subject: string[]; title?: string; text?: string; due?: string; owner?: string; operationId?: string }
  example(
    write(
      "create",
      `add a ${kinds.join(" or ")} to records of the CRM, then store the CRM's copy of it when the activities ` +
        "setting is on",
    )
      .addArgument(new Argument("<kind>", "what to add").choices(kinds))
      .option(
        "--subject <ref>",
        `a record it is on: ${leads ? "deal:<id> or lead:<id>" : "deal:<id>"} as a list shows it, or person:<id> or ` +
          "organization:<id> by the CRM's id as people list and organizations list print it; repeat it for more",
        (value: string, previous: string[] = []) => [...previous, value],
        // The empty default marks the flag as repeatable, so an agent's tool takes a list.
        [] as string[],
      )
      .option(
        "--title <title>",
        task ? "a task's title, needed for a task; a comment's title where the CRM keeps one" : "its title",
      )
      .option("--text <text>", comment ? "a comment's text, needed for a comment; a task's description" : "its text")
      .option(
        "--due <time>",
        "a task's deadline: an ISO 8601 time, a date (its end), today, or 2h, 3d from now; in your time zone",
      )
      .option(
        "--owner <user>",
        "the CRM user a task is assigned to; anyone but the sign-in's own user checks crm.assign-others",
      ),
    ...(comment ? ['activities create comment --subject deal:12 --text "Example: asked for a discount"'] : []),
    ...(task ? ['activities create task --subject deal:12 --title "Example: call back" --due 2026-12-01T10:00'] : []),
  ).action(async (kind: CrmActivityWrite, opts: Typed, command: Command) => {
    await within(command, async (run) => {
      const done = await createCrmActivity(
        contextOf(run, command),
        kind,
        {
          on: opts.subject,
          ...(opts.title === undefined ? {} : { title: opts.title }),
          ...(opts.text === undefined ? {} : { body: opts.text }),
          ...(opts.due === undefined ? {} : { dueAt: aheadOf(opts.due, "--due", now(), { end: true }) }),
          ...(opts.owner === undefined ? {} : { owner: opts.owner }),
        },
        idOf(opts),
      )
      return answered(run, done)
    })
  })
  if (task)
    example(
      write(
        "close",
        "mark a task done in the CRM, then store the CRM's copy of it when the activities setting is on",
      ).argument("<task>", "the task's id in the CRM, as activities list prints its external_id"),
      "activities close 42",
    ).action(async (id: string, opts: { operationId?: string }, command: Command) => {
      await within(command, async (run) =>
        answered(run, await completeCrmActivity(contextOf(run, command), id, idOf(opts))),
      )
    })
}

const writtenOf = (run: CrmRun, activity: CrmActivity, on: CrmActivityWritten["on"]) => ({
  external_id: activity.externalId,
  kind: activity.kind,
  subject: activity.subject,
  body: activity.body ?? null,
  due_at: iso(activity.dueAt ?? null),
  done: activity.done,
  assignee: activity.assignee ? crmIdentityId(run.account, activity.assignee, "user") : null,
  created_at: new Date(activity.createdAt).toISOString(),
  updated_at: new Date(activity.updatedAt).toISOString(),
  on: on.map(({ kind, externalId, ref, title }) => ({ kind, external_id: externalId, ref, title })),
  untrusted: UNTRUSTED,
})
