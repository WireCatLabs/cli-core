import * as v from "valibot"
import { CRM_ACTIVITY_KINDS, type CrmActivityKind } from "../domain/crm.js"
import { DEAL_ROLES } from "../domain/deals.js"
import { count, id, reference, text, time, untrusted } from "./fields.js"
import { recordedMeeting } from "./recorded-meeting.js"

const nullableText = v.nullable(text)
const party = v.strictObject({ ref: reference, name: nullableText, owner: v.boolean() })
const outcome = v.picklist(["open", "won", "lost"])
const crmAccount = v.nullable(v.strictObject({ provider: text, account: text }))
const day = v.nullable(v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/)))

/** A call, e-mail, meeting, to-do, task or comment the CRM keeps on a deal or lead: what `show` lists. */
export interface DealActivity {
  external_id: string
  kind: CrmActivityKind
  subject: string
  body: string | null
  due_at: string | null
  done: boolean
  assignee: string | null
  created_at: string
  updated_at: string
}

// Typed by name: inferred, it makes every entity map that holds a deal too long for the compiler to write out.
const activity: v.GenericSchema<DealActivity> = v.strictObject({
  external_id: text,
  kind: v.picklist(CRM_ACTIVITY_KINDS),
  subject: text,
  body: nullableText,
  due_at: v.nullable(time),
  done: v.boolean(),
  /** The identity `<account>/user/<id>` responsible for it. */
  assignee: nullableText,
  created_at: time,
  updated_at: time,
})

/**
 * A deal (`deal:<id>`), the owner's own or a CRM's copy: one shape for memo and every CRM CLI. Money is a decimal
 * string in its currency, both `null` when no amount is expected.
 */
export const deal = v.strictObject({
  id,
  ref: reference,
  kind: v.picklist(["deal", "lead"]),
  title: text,
  /** One line with the stage, amount and status. */
  summary: text,
  pipeline: reference,
  pipeline_name: text,
  stage: text,
  /** The base stage `stage` maps to, once the owner confirmed it; `null` while unsorted. */
  base_stage: v.nullable(v.strictObject({ ref: reference, name: text })),
  status: outcome,
  organization: v.nullable(party),
  /** A CRM copy's own person and company as the CRM keeps them on it, such as a lead's with nobody linked yet. */
  contact_name: nullableText,
  company_name: nullableText,
  currency: nullableText,
  amount: nullableText,
  close_date: day,
  closed_date: day,
  closed_reason: nullableText,
  rank: v.nullable(v.number()),
  /** A lead's deal, once it became one. */
  deal: v.nullable(reference),
  /** The CRM account it is a copy from; `null` for the owner's own. */
  account: crmAccount,
  external_id: nullableText,
  /** A CRM copy's assignee, the identity `<account>/user/<id>`. */
  assignee: nullableText,
  /** A CRM copy's own fields by code; a list field's value is its option's label, `option_id` its id. */
  provider_metadata: v.record(
    v.string(),
    v.strictObject({
      label: v.nullable(v.string()),
      value: v.unknown(),
      option_id: v.optional(v.union([v.string(), v.array(v.string())])),
    }),
  ),
  people: v.array(v.strictObject({ ...party.entries, role: v.picklist(DEAL_ROLES) })),
  author: v.strictObject({
    type: v.picklist(["person", "bot"]),
    id,
    name: nullableText,
    kind: v.nullable(v.picklist(["agent", "rule"])),
  }),
  model: nullableText,
  source: text,
  reason: nullableText,
  evidence: v.array(reference),
  project: v.nullable(reference),
  project_name: nullableText,
  created_at: time,
  updated_at: time,
  /** `show` of a CRM copy whose `activities` setting is on: its activities and tasks, open ones first. */
  activities: v.optional(v.array(activity)),
  /** `show` of a CRM copy: the newest recorded meetings and calls of its people, in its account's scope. */
  meetings: v.optional(v.array(recordedMeeting)),
  untrusted,
})

/** A lead (`lead:<id>`): a deal's shape, in a lead pipeline. */
export const lead = deal

const pipelineStage = v.strictObject({
  name: text,
  position: count,
  outcome,
  external_id: nullableText,
  /** Open deals or leads in it now. */
  open: count,
  /** With a funnel: rows that got this far, and the share of them that reached the next stage. */
  reached: v.optional(count),
  conversion: v.optional(v.nullable(v.number())),
  /** With a funnel: rows standing in it now, and their sum per currency, never converted. */
  items: v.optional(count),
  amounts: v.optional(v.array(v.strictObject({ amount: text, currency: text, items: count }))),
})

/** A pipeline (`pipeline:<id>`) with its stages in order; `pipelines show` adds the funnel. */
export const pipeline = v.strictObject({
  id,
  ref: reference,
  name: text,
  kind: v.picklist(["deal", "lead"]),
  account: crmAccount,
  external_id: nullableText,
  stages: v.array(pipelineStage),
  created_at: time,
  totals: v.optional(
    v.strictObject({ items: count, open: count, won: count, lost: count, win_rate: v.nullable(v.number()) }),
  ),
  since: v.optional(day),
  untrusted,
})

/** One stage of a pipeline, with the pipeline it is in: what `stages list` answers. */
export const stage = v.strictObject({
  ...pipelineStage.entries,
  pipeline: reference,
  pipeline_name: text,
  kind: v.picklist(["deal", "lead"]),
  untrusted,
})
