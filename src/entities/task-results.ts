import * as v from "valibot"
import { TASK_TYPES } from "../domain/knowledge.js"
import { LINK_KINDS, LINK_SOURCES } from "../store/sqlite/link-kinds.js"
import { PRIORITY_LABELS, TASK_KINDS, TASK_ORIGINS, TASK_STATES, TASK_VERDICTS } from "../tasks/index.js"
import { count, id, reference, text, time } from "./fields.js"
import { closeSuggestion } from "./task.js"
import { taskPair } from "./task-pair.js"

const nullableTime = v.nullable(time)
const link = v.strictObject({
  id,
  from: reference,
  to: v.nullable(reference),
  kind: v.picklist(LINK_KINDS),
  anchor: v.nullable(text),
  origin: v.picklist(LINK_SOURCES),
  target_text: v.nullable(text),
  role: v.nullable(text),
  evidence: v.nullable(text),
  provenance: v.nullable(text),
  confirmed: v.boolean(),
  created_at: time,
})
export const taskCard = v.strictObject({
  id,
  ref: reference,
  key: text,
  project: reference,
  title: text,
  description: v.nullable(text),
  type: v.picklist(TASK_TYPES),
  status: v.picklist(TASK_STATES),
  priority: v.nullable(v.number()),
  priority_label: v.nullable(v.picklist(PRIORITY_LABELS)),
  agent: v.nullable(text),
  revision: v.number(),
  parent: v.nullable(reference),
  source: v.nullable(text),
  due_at: nullableTime,
  next_check_at: nullableTime,
  closed_at: nullableTime,
  reason: v.nullable(text),
  verdict: v.nullable(v.picklist(TASK_VERDICTS)),
  category: v.nullable(text),
  claimed_by: v.nullable(text),
  claimed_until: nullableTime,
  close_certainty: v.nullable(v.number()),
  close_suggestion: v.nullable(closeSuggestion),
  assignments: v.array(v.strictObject({ to: reference, role: v.picklist(["assignee", "reviewer", "watcher"]) })),
  created_at: time,
  updated_at: time,
  links: v.array(link),
  linked_from: v.array(link),
})
/** Service task receipts preserve source pointers and their on-demand previews. */
const taskView = v.strictObject({
  id,
  source: text,
  source_kind: text,
  account: text,
  group: text,
  kind: v.picklist(TASK_KINDS),
  state: v.picklist(TASK_STATES),
  reason: v.optional(text),
  origin: v.picklist(TASK_ORIGINS),
  created_at: time,
  due_at: v.optional(time),
  closed_at: v.optional(time),
  closed_by: v.optional(v.picklist(TASK_ORIGINS)),
  key: v.optional(text),
  category: v.optional(text),
  claimed_by: v.optional(text),
  claimed_until: v.optional(time),
  message: v.nullable(v.strictObject({ sender_name: v.nullable(text), text, timestamp: time })),
  note: v.optional(v.nullable(v.strictObject({ id, title: v.nullable(text), text, updated_at: time }))),
})
export const taskCreated = v.strictObject({
  ...taskView.entries,
  created: v.boolean(),
  attached: v.optional(v.literal(true)),
  review: v.optional(count),
  follow_up_of: v.optional(taskPair.entries.other),
  card: v.optional(taskCard),
})
export const taskClosed = v.strictObject({
  ...taskView.entries,
  close_certainty: v.nullable(v.number()),
  close_suggestion: v.nullable(closeSuggestion),
})
export const taskLinks = v.union([
  v.strictObject({ ...taskCard.entries, review: v.optional(count) }),
  v.strictObject({
    relations: v.array(
      v.strictObject({
        id,
        from: reference,
        to: reference,
        kind: v.picklist(["blocked-by", "follow-up-of", "related-to", "duplicate-of", "discovered-from"]),
      }),
    ),
  }),
])
export const taskSimilar = v.strictObject({
  ref: reference,
  key: text,
  title: text,
  status: text,
  created_at: time,
  found_by: v.array(v.picklist(["text", "person", "category", "reply"])),
  score: v.number(),
  band: taskPair.entries.band,
  levels: taskPair.entries.levels,
  reasons: v.array(text),
  text: v.strictObject({ shared_stems: count, all_stems: count, stems: v.number(), trigrams: v.number() }),
})
export const taskMerge = v.strictObject({ pair: taskPair, linked: count, review: count, task: taskCard })
export const taskUnmerge = v.strictObject({ pair: taskPair, task: taskCard })
export const taskCategories = v.strictObject({
  categories: v.array(
    v.strictObject({
      name: text,
      meaning: text,
      triggers: v.strictObject({ en: v.array(text), ru: v.array(text), es: v.array(text) }),
    }),
  ),
  unlisted: v.array(v.strictObject({ name: text, open: count, total: count })),
  file: v.nullable(text),
})
export const taskScan = v.strictObject({
  chat: text,
  messages: count,
  added: count,
  closed: count,
  review: count,
  held: v.optional(count),
  held_chats: v.optional(count),
  tasks: v.array(v.strictObject({ source: text, kind: v.picklist(TASK_KINDS), category: v.nullable(text) })),
})
