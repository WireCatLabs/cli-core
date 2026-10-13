import * as v from "valibot"
import { TASK_TYPES } from "../store/sqlite/work-tasks.js"
import { TASK_ORIGINS, TASK_STATES } from "../tasks/index.js"
import { id, reference, text, time } from "./fields.js"

export const task = v.strictObject({
  ref: reference,
  id,
  title: v.nullable(text),
  description: v.optional(v.nullable(text)),
  kind: v.picklist(TASK_TYPES),
  state: v.picklist(TASK_STATES),
  origin: v.optional(v.picklist(TASK_ORIGINS)),
  project: v.optional(v.nullable(text)),
  account: v.optional(text),
  /** The chat it came from, as a `chat:` reference. */
  chat: v.optional(v.nullable(reference)),
  /** The message it came from. */
  source_message: v.optional(v.nullable(reference)),
  priority: v.optional(v.nullable(v.number())),
  parent: v.optional(v.nullable(reference)),
  due_at: v.optional(v.nullable(time)),
  closed_at: v.optional(v.nullable(time)),
  reason: v.optional(v.nullable(text)),
  created_at: time,
  updated_at: v.optional(time),
})
