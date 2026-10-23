import * as v from "valibot"
import { id, reference, text, time } from "./fields.js"

export const tagTarget = v.variant("type", [
  v.strictObject({ type: v.literal("chat"), chat_id: id }),
  v.strictObject({ type: v.literal("contact"), person_id: id }),
  v.strictObject({ type: v.literal("message"), chat_id: id, message_id: id, locator: reference }),
  v.strictObject({ type: v.literal("task"), task_id: id }),
])
const receipt = { target: tagTarget, unchanged: v.array(text) }
export const tagChange = v.union([
  v.strictObject({ ...receipt, added: v.array(text) }),
  v.strictObject({ ...receipt, removed: v.array(text) }),
])
export const automaticTags = v.strictObject({
  items: v.array(
    v.union([
      v.strictObject({
        chat_id: id,
        tags: v.array(
          v.strictObject({
            tag: text,
            score: v.number(),
            fields: v.array(v.picklist(["title", "username", "description"])),
          }),
        ),
        algorithm: text,
        fetched_at: v.nullable(time),
        source: v.picklist(["metadata", "stored-chat"]),
      }),
      v.strictObject({ chat_id: id, error: v.strictObject({ code: text, message: text }) }),
    ]),
  ),
  has_more: v.boolean(),
  dry_run: v.boolean(),
})
