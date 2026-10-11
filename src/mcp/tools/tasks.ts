import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { listed } from "../../cli/paging.js"
import type { SendGuard } from "../../sends/guard.js"
import { servicesFor, storedDeps } from "../../services/index.js"
import { momentOf } from "../../services/moment.js"
import type { AccountKey, MessageStore } from "../../store/store.js"
import { TASK_KINDS, TASK_STATES } from "../../tasks/index.js"
import { type AnyTool, chatOf, limit, READ, tool } from "../tool.js"

const LOCAL = { readOnlyHint: false, openWorldHint: false }
const ROW =
  "{ id, source, sourceKind, account, group, kind, state, reason?, origin, createdAt, dueAt?, closedAt?, closedBy?, " +
  "message: { senderName, text, timestamp } | null, note?: { id, title, text, updatedAt } | null }"
const type = v.picklist(TASK_KINDS)

export const tasksTools = (messenger: Messenger): Record<string, AnyTool> => {
  const tasks = (store: MessageStore, account: AccountKey, guard: SendGuard) =>
    servicesFor(storedDeps(messenger, store, account, guard)).tasks
  return {
    tasks_list: tool({
      title: "List tasks",
      description:
        "What waits on the owner — questions nobody answered, mentions, requests, promises — oldest first, each with " +
        "its current message or note preview (`null` when unavailable or deleted). review and serve open and close them. " +
        `Returns { items: [${ROW}], page, limit, hasMore }.`,
      input: v.object({
        state: v.optional(v.picklist(TASK_STATES)),
        chat: v.optional(chatOf(messenger)),
        type: v.optional(v.pipe(v.array(type), v.minLength(1), v.description("only these types"))),
        before_time: v.optional(
          v.pipe(
            v.string(),
            v.minLength(1),
            v.description("only tasks opened before this ISO 8601 time, or 2h / 1d ago"),
          ),
        ),
        limit,
      }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) =>
        listed(
          await tasks(store, account, defaults.guard).list({
            ...(args.state === undefined ? {} : { state: args.state }),
            ...(args.chat === undefined ? {} : { chat: args.chat }),
            ...(args.type === undefined ? {} : { types: args.type }),
            ...(args.before_time === undefined ? {} : { before: momentOf(args.before_time, "before_time") }),
            limit: args.limit ?? defaults.limit,
          }),
        ),
    }),

    tasks_add: tool({
      title: "Add a task",
      description:
        'Adds a task for a message the rules cannot see — "I\'ll send it tomorrow" has no question mark. `message` ' +
        "accepts a msg: locator or note:<id> in the selected account. A source that already has a task of this type keeps it (`created: " +
        `false\`). Writes only to the local store; nothing is sent. Returns ${ROW} with created.`,
      input: v.object({
        message: v.pipe(v.string(), v.minLength(1), v.description("a msg: locator or note:<id>")),
        type,
      }),
      annotations: { ...LOCAL, destructiveHint: false, idempotentHint: true },
      stored: async (store, account, args, defaults) => {
        const { task, created } = await tasks(store, account, defaults.guard).add(args.message, args.type, "agent")
        return { ...task, created }
      },
    }),

    tasks_close: tool({
      title: "Close a task",
      description:
        "Closes a task as done, or as dismissed when it needs no answer; `reason` is kept with it. A closed task " +
        `stays closed, and the rules never reopen it. Writes only to the local store; nothing is sent. Returns ${ROW}.`,
      input: v.object({
        task: v.pipe(v.string(), v.minLength(1), v.description("the task's id, from tasks_list")),
        as: v.picklist(["done", "dismissed"]),
        reason: v.optional(v.pipe(v.string(), v.minLength(1), v.description("why — no-reply-needed, for example"))),
      }),
      annotations: { ...LOCAL, destructiveHint: false, idempotentHint: false },
      stored: async (store, account, args, defaults) => {
        return tasks(store, account, defaults.guard).close(args.task, {
          as: args.as,
          by: "agent",
          ...(args.reason === undefined ? {} : { reason: args.reason }),
        })
      },
    }),

    stats_tasks_show: tool({
      title: "Task statistics",
      description:
        "Per chat: how many tasks are open, when the oldest open one was opened, and the median time to close. " +
        "Returns { items: [{ group, open, oldestOpenAt?, medianCloseMs? }], page, limit, hasMore }.",
      input: v.object({ chat: v.optional(chatOf(messenger)), type: v.optional(type) }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) =>
        listed(
          await tasks(store, account, defaults.guard).stats({
            ...(args.chat === undefined ? {} : { chat: args.chat }),
            ...(args.type === undefined ? {} : { type: args.type }),
          }),
        ),
    }),
  }
}
