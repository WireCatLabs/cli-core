import * as v from "valibot"
import { RELATION_KINDS } from "../store/sqlite/link-kinds.js"
import { id, reference, text, time } from "./fields.js"

/** A link the owner or an agent drew between two people, organizations, projects or tasks. */
export const relationship = v.strictObject({
  id,
  from: reference,
  to: reference,
  kind: v.picklist(RELATION_KINDS),
  role: v.nullable(text),
  evidence: v.nullable(text),
  /** An agent's suggestion stays unconfirmed, and `weak`, until the owner confirms it. */
  confirmed: v.boolean(),
  provenance: v.nullable(text),
  confidence_category: v.picklist(["owner-confirmed", "weak"]),
  created_at: time,
})
