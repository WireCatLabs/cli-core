import * as v from "valibot"
import { TASK_TYPES } from "../domain/knowledge.js"
import { PRIORITY_LABELS, TASK_ORIGINS, TASK_STATES } from "../tasks/index.js"
import { id, reference, text, time } from "./fields.js"

export const closeSuggestion = v.strictObject({
  as: v.picklist(["done", "dismissed"]),
  /** The agent's name. */
  by: text,
  /** 0–1, as the agent rated it. */
  certainty: v.number(),
  reason: v.nullable(text),
  at: time,
})

export const task = v.strictObject({
  ref: reference,
  id,
  /** The readable key: `Q-15` for a task found in a message from now on, `IN1A2B3C4D-17` before, `HRB-12` in a project. */
  key: v.optional(v.nullable(text)),
  title: v.nullable(text),
  description: v.optional(v.nullable(text)),
  kind: v.picklist(TASK_TYPES),
  state: v.picklist(TASK_STATES),
  origin: v.optional(v.picklist(TASK_ORIGINS)),
  project: v.optional(v.nullable(text)),
  /** The project's key and name, as `tasks counts` names it. */
  project_key: v.optional(v.nullable(text)),
  project_name: v.optional(v.nullable(text)),
  /** Who added it: the owner, or an agent by its bot name. */
  created_by: v.optional(
    v.nullable(v.strictObject({ type: v.picklist(["person", "bot"]), id, name: v.nullable(text), owner: v.boolean() })),
  ),
  account: v.optional(text),
  /** The chat it came from, as a `chat:` reference. */
  chat: v.optional(v.nullable(reference)),
  /** The message it came from. */
  source_message: v.optional(v.nullable(reference)),
  /** 0 to 1, higher first; `priority_label` reads it as low, medium, high or critical. */
  priority: v.optional(v.nullable(v.number())),
  priority_label: v.optional(v.nullable(v.picklist(PRIORITY_LABELS))),
  /** The agent working on it, apart from its assignees and its claim. */
  agent: v.optional(v.nullable(text)),
  /** Give it back with `--revision` to refuse a write made on a stale copy. */
  revision: v.optional(v.number()),
  assignments: v.optional(
    v.array(v.strictObject({ to: reference, role: v.picklist(["assignee", "reviewer", "watcher"]) })),
  ),
  /** Open work whose blocked-by tasks are all done. */
  ready: v.optional(v.boolean()),
  /** The blocked-by tasks not done yet: open (any open state), dismissed, or unavailable. */
  blocked_by: v.optional(
    v.array(v.strictObject({ task: reference, state: v.picklist(["open", "dismissed", "unavailable"]) })),
  ),
  parent: v.optional(v.nullable(reference)),
  due_at: v.optional(v.nullable(time)),
  closed_at: v.optional(v.nullable(time)),
  reason: v.optional(v.nullable(text)),
  /** One name from the category list (`tasks categories`). */
  category: v.optional(v.nullable(text)),
  /** Who works on it now, and until when; null when nobody does. */
  claimed_by: v.optional(v.nullable(text)),
  claimed_until: v.optional(v.nullable(time)),
  /** The close an agent would make, waiting on the owner: `tasks close` confirms it, `tasks reject` refuses it. */
  close_suggestion: v.optional(v.nullable(closeSuggestion)),
  created_at: time,
  updated_at: v.optional(time),
})
