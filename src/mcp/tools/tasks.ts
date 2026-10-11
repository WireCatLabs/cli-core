import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { listed } from "../../cli/paging.js"
import type { SendGuard } from "../../sends/guard.js"
import { kindsOf } from "../../services/inbox.js"
import { servicesFor, storedDeps } from "../../services/index.js"
import { aheadOf, momentOf } from "../../services/moment.js"
import { TASK_LINK_KINDS, type TaskPlan } from "../../services/tasks.js"
import type { AccountKey, MessageStore } from "../../store/store.js"
import { TASK_KINDS, TASK_STATES } from "../../tasks/index.js"
import { type AnyTool, chatOf, limit, READ, tool } from "../tool.js"

const LOCAL = { readOnlyHint: false, openWorldHint: false }
const ROW =
  "{ id, source, sourceKind, account, group, kind, state, reason?, origin, createdAt, dueAt?, closedAt?, closedBy?, " +
  "message: { senderName, text, timestamp } | null, note?: { id, title, text, updatedAt } | null }"
const type = v.picklist(TASK_KINDS)
const CARD =
  "{ id, ref, key, project, title, description, type, status, priority, parent, source, dueAt, nextCheckAt, closedAt, " +
  "reason, verdict, assignments, createdAt, updatedAt, links: [{ id, from, to, kind, targetText, origin, … }] }"
const text = (max: number, what: string) => v.pipe(v.string(), v.minLength(1), v.maxLength(max), v.description(what))
const ahead = (what: string) =>
  v.optional(
    v.nullable(
      v.pipe(v.string(), v.minLength(1), v.description(`${what}: an ISO 8601 time or 2h, 3d from now; null clears it`)),
    ),
  )
const PLAN = {
  title: v.optional(text(300, "one line: the action and its object — send Alex the API token")),
  description: v.optional(
    v.nullable(
      text(
        20000,
        "Markdown: who owes whom, the counterpart, done when, next step, search keywords. Never paste message text — link the message",
      ),
    ),
  ),
  due: ahead("when it must be done"),
  next_check: ahead("when to look at it again"),
}
const planOf = (args: {
  title?: string
  description?: string | null
  due?: string | null
  next_check?: string | null
}): TaskPlan => ({
  ...(args.title === undefined ? {} : { title: args.title }),
  ...(args.description === undefined ? {} : { description: args.description }),
  ...(args.due === undefined ? {} : { dueAt: args.due === null ? null : new Date(aheadOf(args.due, "due")) }),
  ...(args.next_check === undefined
    ? {}
    : { nextCheckAt: args.next_check === null ? null : new Date(aheadOf(args.next_check, "next_check")) }),
})
const span = (what: string) =>
  v.optional(v.pipe(v.string(), v.regex(/^\d+(m|h|d)$/), v.description(`${what}: 30m, 2h, 7d`)))
const spanMs = (typed: string | undefined) => (typed === undefined ? undefined : Date.now() - momentOf(typed, "span"))

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
        ...PLAN,
      }),
      annotations: { ...LOCAL, destructiveHint: false, idempotentHint: true },
      stored: async (store, account, args, defaults) => {
        const { task, created, card } = await tasks(store, account, defaults.guard).add(
          args.message,
          args.type,
          "agent",
          planOf(args),
        )
        return { ...task, created, ...(card ? { card } : {}) }
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

    tasks_plan: tool({
      title: "Plan a task",
      description:
        "Sets a task's title, description, due date and next check — when you should look at it again. The next " +
        "check is yours, not a reminder: nothing reaches the owner. Writes only to the local store; nothing is sent. " +
        `Returns ${CARD}.`,
      input: v.object({ task: text(200, "the task's id or key, from tasks_list or tasks_agenda"), ...PLAN }),
      annotations: { ...LOCAL, destructiveHint: false, idempotentHint: true },
      stored: async (store, account, args, defaults) =>
        tasks(store, account, defaults.guard).plan(args.task, planOf(args), "agent"),
    }),

    tasks_link: tool({
      title: "Link a task",
      description:
        "Links a task to what it concerns, so the next look starts from there: msg: locators, chats, person:<id>, " +
        "document:<id>, note:<id>, or a URL. A message the store has not saved yet is kept as written. Writes only " +
        `to the local store; nothing is sent. Returns ${CARD}.`,
      input: v.object({
        task: text(200, "the task's id or key"),
        targets: v.optional(v.array(text(500, "a reference, a msg: locator or a URL"))),
        chats: v.optional(v.array(chatOf(messenger))),
        kind: v.optional(v.picklist(TASK_LINK_KINDS)),
      }),
      annotations: { ...LOCAL, destructiveHint: false, idempotentHint: true },
      stored: async (store, account, args, defaults) =>
        tasks(store, account, defaults.guard).link(
          args.task,
          { references: args.targets ?? [], chats: args.chats ?? [] },
          { kind: args.kind ?? "related-to", by: "agent" },
        ),
    }),

    tasks_show: tool({
      title: "Show a task",
      description: `One task with its plan and everything linked to it. Returns ${CARD}.`,
      input: v.object({ task: text(200, "the task's id or key") }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) => tasks(store, account, defaults.guard).show(args.task),
    }),

    tasks_agenda: tool({
      title: "Today's agenda",
      description:
        "What needs a look, from the local store and without message text: open tasks overdue, due soon, due a " +
        "check, or never planned; chats where someone else wrote last and the owner has not answered (`owed`); " +
        "chats where the owner wrote last and nobody answered (`waiting`). Read only what it names. `stale` means " +
        "the store saved nothing for a day, so a chat may look quiet only because nothing was synced. Returns { at, " +
        "account, storedAt, stale, tasks: [{ id, key, title, type, source, dueAt, nextCheckAt, createdAt, reasons }], " +
        "owed: [{ chatId, title, kind, lastMessage, lastMessageAt, lastFromOwner, openTasks }], waiting: [same], " +
        "unsynced: [same, lastMessage null — the chat moved and its newest message is not stored: read it first] }.",
      input: v.object({
        due: span("list tasks due within this (default 1d)"),
        unanswered: span("list chats someone else wrote last in this long ago (default 1d)"),
        waiting: span("list chats the owner wrote last in this long ago (default 7d)"),
        within: span("leave out chats silent longer than this (default 30d)"),
        kind: v.optional(
          v.pipe(v.string(), v.minLength(1), v.description("chat kinds, comma-separated: dialog,group")),
        ),
      }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) => {
        const [dueWithin, unanswered, waiting, within] = [args.due, args.unanswered, args.waiting, args.within].map(
          spanMs,
        )
        return servicesFor(storedDeps(messenger, store, account, defaults.guard)).agenda.show({
          ...(dueWithin === undefined ? {} : { dueWithin }),
          ...(unanswered === undefined ? {} : { unanswered }),
          ...(waiting === undefined ? {} : { waiting }),
          ...(within === undefined ? {} : { within }),
          ...(args.kind === undefined ? {} : { kinds: kindsOf(args.kind, "kind") }),
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
