import * as v from "valibot"
import { MEMORY_KINDS, MEMORY_SCOPES, MEMORY_STATUSES } from "../domain/knowledge.js"
import { author, evidenceSource, id, reference, text, time } from "./fields.js"

export const memory = v.strictObject({
  ref: reference,
  id,
  kind: v.picklist(MEMORY_KINDS),
  text,
  subject: v.nullable(reference),
  /** What the subject is called; `null` for the owner and for a row with no name. */
  subject_name: v.optional(v.nullable(text)),
  subject_is_owner: v.optional(v.boolean()),
  /** The project it belongs to, and what that project is called. */
  project: v.optional(v.nullable(reference)),
  project_name: v.optional(v.nullable(text)),
  author,
  model: v.nullable(text),
  confidence: v.nullable(v.number()),
  status: v.picklist(MEMORY_STATUSES),
  scope: v.picklist(MEMORY_SCOPES),
  supersedes: v.nullable(reference),
  evidence: v.array(reference),
  /** With `--sources`: each piece of evidence read back. */
  sources: v.optional(v.array(evidenceSource)),
  last_verified_at: v.nullable(time),
  created_at: time,
  updated_at: time,
})
