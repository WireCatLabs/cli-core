import * as v from "valibot"
import { count, reference, text, time } from "./fields.js"

export interface RecordedMeeting {
  ref: string
  meeting_id: number
  account: { provider: string; account: string }
  title: string | null
  started_at: string | null
  duration_ms: number | null
  has_transcript: boolean
  event: string | null
  people: string[]
}

// Typed by name, as a deal's activity is: inferred, the entity maps that hold it grow too long for the compiler.
/** A recorded meeting or call some of the people took part in: `meetings show <meeting_id>` of `account` opens it. */
export const recordedMeeting: v.GenericSchema<RecordedMeeting> = v.strictObject({
  ref: reference,
  meeting_id: count,
  account: v.strictObject({ provider: text, account: text }),
  title: v.nullable(text),
  started_at: v.nullable(time),
  duration_ms: v.nullable(count),
  has_transcript: v.boolean(),
  event: v.nullable(reference),
  people: v.array(reference),
})
