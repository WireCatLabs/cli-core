import * as v from "valibot"
import { count, id, reference, text, time, untrusted } from "./fields.js"

const nullableText = v.nullable(text)
const party = v.strictObject({ ref: reference, name: nullableText, owner: v.boolean() })
const outcome = v.picklist(["open", "won", "lost"])
const crmAccount = v.nullable(v.strictObject({ provider: text, account: text }))
const day = v.nullable(v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/)))

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
  status: outcome,
  organization: v.nullable(party),
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
  people: v.array(v.strictObject({ ...party.entries, role: v.picklist(["owner", "contact", "decision-maker"]) })),
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
