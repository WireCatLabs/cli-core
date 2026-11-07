import * as v from "valibot"
import { RELATION_KINDS, STANDINGS } from "../domain/relations.js"
import { id, reference, text, time } from "./fields.js"

/** A link the owner, an agent or a source drew between people, organizations, projects, tasks and deals. */
export const relationship = v.strictObject({
  id,
  from: reference,
  to: reference,
  kind: v.picklist(RELATION_KINDS),
  role: v.nullable(text),
  /** A purpose from memo's config; `null` means `work`. */
  purpose: v.nullable(text),
  evidence: v.nullable(text),
  /** An agent's suggestion stays unconfirmed, and `weak`, until the owner confirms it. */
  confirmed: v.boolean(),
  provenance: v.nullable(text),
  confidence_category: v.picklist(["owner-confirmed", "weak"]),
  /** `reported`: a CRM account says so and nobody confirmed it; `ended`: it no longer holds. */
  standing: v.picklist(STANDINGS),
  /** A job title beside it, never its role. */
  position: v.nullable(text),
  starts_at: v.nullable(time),
  ends_at: v.nullable(time),
  created_at: time,
})
