import * as v from "valibot"
import { FACT_TYPES, WORK_TASK_TYPES } from "../domain/knowledge.js"
import { author, id, reference, text, time } from "./fields.js"

const evidence = v.strictObject({ reference, fingerprint: text })
const base = { id, project: reference, evidence: v.array(evidence) }
const finding = v.variant("kind", [
  v.strictObject({ ...base, kind: v.literal("fact"), type: v.picklist(FACT_TYPES), statement: text }),
  v.strictObject({
    ...base,
    kind: v.literal("task"),
    type: v.picklist(WORK_TASK_TYPES),
    title: text,
    reason: text,
    commitment: v.picklist(["explicit", "inferred"]),
    due_at: v.optional(time),
    due_evidence: v.optional(v.array(reference)),
    assignee: v.optional(reference),
    assignee_evidence: v.optional(v.array(reference)),
  }),
])
const outcome = v.strictObject({
  id,
  fingerprint: text,
  status: v.picklist(["accepted", "rejected"]),
  reference: v.nullable(reference),
  reused: v.boolean(),
})
export const meetingFindings = v.strictObject({
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
