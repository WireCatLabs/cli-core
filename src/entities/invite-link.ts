import * as v from "valibot"
import { count, text, time } from "./fields.js"

/** A link people join a group by. */
export const inviteLink = v.strictObject({
  link: text,
  /** Who joins by it asks first, and an admin lets them in. */
  approval: v.boolean(),
  /** `null` when it never expires. */
  expires_at: v.nullable(time),
  /** `null` for no limit. */
  max_uses: v.nullable(count),
  /** The group's own link; revoking it makes the messenger issue a new one. */
  primary: v.optional(v.boolean()),
  revoked: v.optional(v.boolean()),
  pending_count: v.optional(count),
  joined_count: v.optional(count),
})
