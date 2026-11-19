import * as v from "valibot"
import { id } from "./fields.js"
import { message } from "./message.js"

const operated = { operation_id: id, chat_id: id }
export const messagePin = v.strictObject({ ...operated, message_id: id, pinned: v.boolean() })
export const messageStar = v.strictObject({ ...operated, message_id: id, starred: v.boolean() })
export const messageDeletion = v.strictObject({ ...operated, deleted: v.array(id), for_everyone: v.boolean() })
/** Scheduled ids, which are never the ids of sent messages. */
export const scheduledCancellation = v.strictObject({ ...operated, cancelled: v.array(id) })
const scheduledSendEntries = { ...operated, sent: v.array(id), messages: v.array(message) }
type ScheduledSendEntriesOf = typeof scheduledSendEntries
// Named, so the entity registry's declaration refers to it instead of spelling a message out again (TS7056).
export interface ScheduledSendEntries extends ScheduledSendEntriesOf {}
/** `sent` holds the scheduled ids; `messages` the messages as sent, with their new ids. */
export const scheduledSend: v.StrictObjectSchema<ScheduledSendEntries, undefined> = v.strictObject(scheduledSendEntries)
