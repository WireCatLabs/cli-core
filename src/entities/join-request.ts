import * as v from "valibot"
import { id, text, time } from "./fields.js"

/** Somebody waiting for an admin to let them into a group. */
export const joinRequest = v.strictObject({
  person_id: id,
  name: v.nullable(text),
  username: v.nullable(text),
  /** `null` where the messenger does not say. */
  requested_at: v.nullable(time),
  /** The note they sent with the request. */
  about: v.optional(text),
})
