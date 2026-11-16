import { annotate } from "@wirecat/cli-base/commands"
import type { QueryRegistry } from "@wirecat/cli-base/query"
import type { Command } from "commander"
import * as v from "valibot"
import { answerEntity } from "../../cli/answer-entity.js"
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
import { CRM_ACTIVITY_KINDS, CRM_KINDS, type CrmActivityKind } from "../../domain/crm.js"
import { text, time } from "../../entities/fields.js"
import type { ListedActivity } from "../../store/sqlite/crm-activities.js"
import { crmSettingKey } from "../../store/sqlite/crm-settings.js"
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

const itemOf = (one: ListedActivity) => ({
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
}

/** `activities list`: the copy's CRM activities and tasks, mounted when the CLI copies them (WC-ARCH-5). */
export const addCrmActivityCommands = (program: Command, options: CrmActivityCommandOptions): void => {
  const { within, example, now, ownerOf, pathOf } = options
  const group = annotate(program.command("activities"), { effects: NO_EFFECTS }).description(
    "the CRM's activities and tasks on deals, leads, contacts and companies, as last synced",
  )
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
    const due = timeBounds(nativeTerms(listQuery(typedQuery(words), ACTIVITIES_QUERY, name), name).get("due"))
    const ref = REFS.find((kind) => terms.has(kind))
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
        status: (terms.get("status") as "open" | "done" | undefined) ?? (terms.has("overdue") ? undefined : "open"),
        ...(due.since === undefined && due.until === undefined
          ? {}
          : {
              due: {
                ...(due.since === undefined ? {} : { since: due.since }),
                ...(due.until === undefined ? {} : { until: due.until }),
              },
            }),
        ...(terms.get("overdue") === "true" ? { overdueAt: now() } : {}),
        ...(terms.has("kind") ? { kinds: [terms.get("kind") as CrmActivityKind] } : {}),
        ...(ref ? { on: refOf(ref, terms.get(ref) as string) } : {}),
        ...(terms.has("owner") ? { owner: await ownerOf(run, terms.get("owner") as string) } : {}),
        limit: opts.limit,
        offset: (opts.page - 1) * opts.limit,
      })
      return listOf(pathOf(command).join(" "), {
        items: found.items.map(itemOf),
        ...paged,
        has_more: found.hasMore,
        ...(due.meta ? { meta: due.meta } : {}),
      })
    })
  })
}

/** `deal:12` as typed, or a bare id for the field it was given to. */
const refOf = (kind: string, value: string) => (value.includes(":") ? value : `${kind}:${value}`)
