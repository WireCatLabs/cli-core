import * as v from "valibot"
import { FACT_TYPES, MEMORY_KINDS, MEMORY_SCOPES, WORK_TASK_TYPES } from "../domain/knowledge.js"
import { author, id, reference, text, time } from "./fields.js"

const evidence = v.strictObject({ reference, fingerprint: text })
const base = { id, evidence: v.array(evidence) }
const finding = v.variant("kind", [
  v.strictObject({
    ...base,
    kind: v.literal("task"),
    project: v.optional(reference),
    type: v.picklist(WORK_TASK_TYPES),
    title: text,
    reason: text,
    commitment: v.picklist(["explicit", "inferred"]),
    due_at: v.optional(time),
    due_evidence: v.optional(v.array(reference)),
    assignee: v.optional(reference),
    assignee_evidence: v.optional(v.array(reference)),
  }),
  v.strictObject({
    ...base,
    kind: v.literal("fact"),
    project: v.optional(reference),
    subject: v.optional(reference),
    type: v.picklist(FACT_TYPES),
    statement: text,
  }),
  v.strictObject({
    ...base,
    kind: v.literal("task_update"),
    task: reference,
    change: v.picklist(["close", "due", "detail"]),
    due_at: v.optional(time),
    detail: v.optional(text),
    reason: text,
  }),
  v.strictObject({
    ...base,
    kind: v.literal("memory"),
    memory_kind: v.picklist(MEMORY_KINDS),
    scope: v.picklist(MEMORY_SCOPES),
    body: text,
    subject: v.optional(reference),
    project: v.optional(reference),
  }),
  v.strictObject({ ...base, kind: v.literal("link"), from: reference, to: reference, reason: text }),
  v.strictObject({ ...base, kind: v.literal("new_contact"), address: text, name: text, reason: v.optional(text) }),
])
const outcome = v.strictObject({
  id,
  fingerprint: text,
  status: v.picklist(["accepted", "rejected"]),
  reference: v.nullable(reference),
  reused: v.boolean(),
})
/** A mail findings batch: what an agent read in one mailbox's new mail, waiting for the owner. */
export const mailFindings = v.strictObject({
  id,
  account: v.strictObject({ provider: text, account: text }),
  input: v.strictObject({ schema_version: v.literal(1), key: text, extractor: text, findings: v.array(finding) }),
  fingerprint: text,
  status: v.picklist(["proposed", "reviewed"]),
  author,
  decided_by: v.nullable(v.strictObject({ type: v.picklist(["person", "bot"]), id })),
  decided_at: v.nullable(time),
  previous: v.array(outcome),
  receipt: v.nullable(v.strictObject({ preview_fingerprint: text, accepted: v.array(id), items: v.array(outcome) })),
})
