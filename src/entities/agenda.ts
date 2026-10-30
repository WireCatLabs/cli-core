import * as v from "valibot"
import { TASK_TYPES } from "../domain/knowledge.js"
import { id, reference, text, time } from "./fields.js"
import { closeSuggestion } from "./task.js"

const agendaChat = v.strictObject({
  chat: reference,
  title: v.nullable(text),
  kind: v.picklist(["dialog", "group", "channel", "saved", "unknown"]),
  /** The newest message, never its text; `null` while it is not stored. */
  last_message: v.nullable(reference),
  last_message_at: time,
  /** `null` when the newest message is not stored, or the messenger did not say who sent it. */
  last_from_owner: v.nullable(v.boolean()),
  /** Open tasks whose source is in this chat. */
  open_tasks: v.array(id),
  /** `unknown` means nothing ever fetched the chat's history; `partial` that the store holds only part of it. */
  completeness: v.strictObject({
    state: v.picklist(["complete", "partial", "unknown"]),
    up_to_date: v.nullable(v.boolean()),
    gaps: v.boolean(),
    reaches_start: v.boolean(),
    fetched_at: v.nullable(time),
  }),
  /** What the store holds of the chat: the count and the span, never the text. */
  held: v.strictObject({ messages: v.number(), oldest_at: v.nullable(time), newest_at: v.nullable(time) }),
})

/** What needs a look today, from the store alone and without one message's text. */
export const agenda = v.strictObject({
  at: time,
  account: text,
  stored_at: v.nullable(time),
  /** The store saved nothing for a day: a chat may look quiet only because nothing was synced. */
  stale: v.boolean(),
  tasks: v.array(
    v.strictObject({
      id,
      key: text,
      title: v.nullable(text),
      kind: v.picklist(TASK_TYPES),
      category: v.nullable(text),
      /** The message or note it came from. */
      source: v.nullable(reference),
      due_at: v.nullable(time),
      next_check_at: v.nullable(time),
      /** Who works on it now; only the asker's own claims are listed unless the query names claimed:. */
      claimed_by: v.nullable(text),
      claimed_until: v.nullable(time),
      /** An agent's close waiting on the owner: `tasks close` confirms it, `tasks reject` refuses it. */
      close_suggestion: v.nullable(closeSuggestion),
      created_at: time,
      reasons: v.array(v.picklist(["overdue", "due", "check", "unplanned", "close-suggested"])),
    }),
  ),
  /** Someone else wrote last, and the owner has not answered. */
  owed: v.array(agendaChat),
  /** The owner wrote last, and nobody answered. */
  waiting: v.array(agendaChat),
  /** The chat list says these moved and their newest message is not stored: read them first. */
  unsynced: v.array(agendaChat),
  /** Open tasks someone else does: what they owe the owner, oldest first. */
  assigned: v.array(
    v.strictObject({
      id,
      key: text,
      title: v.nullable(text),
      kind: v.picklist(TASK_TYPES),
      category: v.nullable(text),
      source: v.nullable(reference),
      due_at: v.nullable(time),
      created_at: time,
      /** `person:<id>`, each one who does it. */
      assignees: v.array(reference),
    }),
  ),
  /** Open tasks carry these categories, which the list no longer holds: move them, or put the category back. */
  unlisted_categories: v.array(v.strictObject({ name: text, open_tasks: v.number() })),
})
