import * as v from "valibot"
import { text, time } from "./fields.js"

/** Somewhere else the account is logged in: a device or an app, as the messenger names it. */
export const accountSession = v.strictObject({
  current: v.boolean(),
  client: v.nullable(text),
  device: v.nullable(text),
  location: v.nullable(text),
  last_active_at: v.nullable(time),
  created_at: v.optional(v.nullable(time)),
})
