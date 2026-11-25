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

/** One stage a deal or lead entered: `exact` from the CRM's own history, else as a sync saw the copy change. */
export interface DealStageEntry {
  from: string | null
  to: string
  at: string
  exact: boolean
}

const stageEntry: v.GenericSchema<DealStageEntry> = v.strictObject({
  from: nullableText,
  to: text,
  at: time,
  exact: v.boolean(),
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
  /**
   * A CRM copy's own fields by code; a list field's value is its option's label, `option_id` its id. `amount_note` is
   * WireCat's own note, not a CRM field: the CRM's amount the store could not keep, and why.
   */
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
    type: v.picklist(["person", "agent"]),
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
  /**
   * `show` of a CRM copy: every stage it entered, oldest first. Once the CRM's own history names any, it alone is
   * listed, from as far back as it was read; the copy's changes between syncs are left out.
   */
  stage_history: v.optional(v.array(stageEntry)),
  untrusted,
})

/** A lead (`lead:<id>`): a deal's shape, in a lead pipeline. */
export const lead = deal

const amount = v.strictObject({ amount: text, currency: text, items: count })
const winRate = v.nullable(v.number())

/** `pipelines show`: the rows made in the window, by their CRM assignee. */
export interface PipelineOwner {
  assignee: string | null
  name: string | null
  open: number
  won: number
  lost: number
  win_rate: number | null
}

const pipelineOwner: v.GenericSchema<PipelineOwner> = v.strictObject({
  assignee: nullableText,
  name: nullableText,
  open: count,
  won: count,
  lost: count,
  win_rate: winRate,
})

export interface PipelineClosed {
  won: number
  lost: number
  win_rate: number | null
  won_amounts: { amount: string; currency: string; items: number }[]
}

const pipelineClosed: v.GenericSchema<PipelineClosed> = v.strictObject({
  won: count,
  lost: count,
  win_rate: winRate,
  won_amounts: v.array(amount),
})

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
  amounts: v.optional(v.array(amount)),
  /** With a funnel: the median days a row of the window stayed in it before it moved on. */
  median_days: v.optional(v.nullable(v.number())),
})

/** One stage in a pipeline's answer, typed by name for the same reason as `activity`. */
export interface PipelineStageAnswer {
  name: string
  position: number
  outcome: "open" | "won" | "lost"
  external_id: string | null
  open: number
  reached?: number
  conversion?: number | null
  items?: number
  amounts?: { amount: string; currency: string; items: number }[]
  median_days?: number | null
}

const pipelineStageAnswer: v.GenericSchema<PipelineStageAnswer> = pipelineStage

/** A pipeline (`pipeline:<id>`) with its stages in order; `pipelines show` adds the funnel. */
export const pipeline = v.strictObject({
  id,
  ref: reference,
  name: text,
  kind: v.picklist(["deal", "lead"]),
  account: crmAccount,
  external_id: nullableText,
  stages: v.array(pipelineStageAnswer),
  created_at: time,
  /** `show`: the rows made in the window. */
  totals: v.optional(v.strictObject({ items: count, open: count, won: count, lost: count, win_rate: winRate })),
  window: v.optional(v.strictObject({ since: v.nullable(time), until: v.nullable(time) })),
  since: v.optional(day),
  /** `show`: rows closed on a day in the window, in the owner's zone. */
  closed: v.optional(pipelineClosed),
  /** `show`: days from made to won, of the rows won in the window. */
  cycle: v.optional(v.strictObject({ median_days: v.nullable(v.number()), items: count })),
  owners: v.optional(v.array(pipelineOwner)),
  lost_reasons: v.optional(v.array(v.strictObject({ reason: text, items: count }))),
  /** `show`: rows whose stages came from the CRM's own history, and from the copy's diffs. */
  history: v.optional(v.strictObject({ exact: count, copy: count })),
  untrusted,
})

/** One stage of a pipeline, with the pipeline it is in: what `stages list` answers. */
export interface StageAnswer extends PipelineStageAnswer {
  pipeline: string
  pipeline_name: string
  kind: "deal" | "lead"
  stage_task?: { title: string; due_days: number } | null
  untrusted?: string[]
}

export const stage: v.GenericSchema<StageAnswer> = v.strictObject({
  ...pipelineStage.entries,
  pipeline: reference,
  pipeline_name: text,
  kind: v.picklist(["deal", "lead"]),
  /** A CRM's stage: the task its `stage-tasks` rule opens when a row enters it, or `null`. */
  stage_task: v.optional(v.nullable(v.strictObject({ title: text, due_days: count }))),
  untrusted,
})
