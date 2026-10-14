import * as v from "valibot"
import { id, text, time } from "./fields.js"

/** One person's vote in a poll that is not anonymous. */
export const pollVote = v.strictObject({
  person_id: id,
  name: v.nullable(text),
  username: v.nullable(text),
  /** Answer ids, as `polls show` prints them. */
  answers: v.array(id),
  voted_at: time,
})
