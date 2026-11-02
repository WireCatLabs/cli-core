import * as v from "valibot"
import { FACT_STATUSES, FACT_TYPES, MEMORY_SCOPES } from "../domain/knowledge.js"
import { PAYMENT_DIRECTIONS, PAYMENT_STATES } from "../meetings/index.js"
import { author, evidenceSource, id, reference, text, time } from "./fields.js"

const payment = v.strictObject({
  amount: text,
  currency: text,
  direction: v.picklist(PAYMENT_DIRECTIONS),
  counterparty: v.nullable(reference),
  counterparty_name: v.nullable(text),
  due_at: v.nullable(text),
  state: v.picklist(PAYMENT_STATES),
  item: v.nullable(text),
})

export const fact = v.strictObject({
  ref: reference,
  id,
  kind: v.picklist(FACT_TYPES),
  text,
  status: v.picklist(FACT_STATUSES),
  project: v.nullable(text),
  /** What the project is called. */
  project_name: v.optional(v.nullable(text)),
  subject: v.nullable(reference),
  /** What the subject is called; `null` for the owner and for a row with no name. */
  subject_name: v.optional(v.nullable(text)),
  subject_is_owner: v.optional(v.boolean()),
  occurred_at: v.nullable(time),
  supersedes: v.nullable(reference),
  author,
  model: v.nullable(text),
  /** Who accepted it; `null` while it is proposed. */
  confirmed_by: v.optional(v.nullable(v.strictObject({ type: v.picklist(["person", "bot"]), id }))),
  scope: v.nullable(v.picklist(MEMORY_SCOPES)),
  /** Who recorded it: the owner, or an agent whose fact waits as proposed. */
  origin: v.picklist(["owner", "agent"]),
  evidence: v.array(reference),
  /** A `payment` fact's fields. */
  payment: v.optional(v.nullable(payment)),
  /** With `--sources`: each piece of evidence read back. */
  sources: v.optional(v.array(evidenceSource)),
  created_at: time,
  updated_at: time,
})
