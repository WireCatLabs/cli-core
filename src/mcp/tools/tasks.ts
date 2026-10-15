import * as v from "valibot"
import { itemOf, listOf, snakeKeys } from "../../cli/envelope.js"
import { listQuery, queryArgument } from "../../cli/list-query.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { taskStatsAnswer } from "../../cli/messenger/stats-answers.js"
import type { SendGuard } from "../../sends/guard.js"
import { AGENDA_QUERY, agendaItem } from "../../services/agenda.js"
import { servicesFor, storedDeps } from "../../services/index.js"
import { aheadOf, momentOf } from "../../services/moment.js"
import { DEFAULT_TASK_CATEGORIES } from "../../services/task-categories.js"
import { TASK_LINK_KINDS, TASK_QUERY, type TaskPlan } from "../../services/tasks.js"
import type { AccountKey, MessageStore } from "../../store/store.js"
import { TASK_KINDS } from "../../tasks/index.js"
import { type AnyTool, chatOf, limit, page, paging, READ, tool } from "../tool.js"

const LOCAL = { readOnlyHint: false, openWorldHint: false }
const ROW =
  "{ item: { id, key, source, source_kind, account, group, kind, category, state, reason?, origin, created_at, due_at?, " +
  "closed_at?, closed_by?, message: { sender_name, text, timestamp } | null, note?: { id, title, text, updated_at } | null } }"
const type = v.picklist(TASK_KINDS)
const CARD =
  "{ item: { id, ref, key, project, title, description, type, status, priority, parent, source, due_at, " +
  "next_check_at, closed_at, reason, verdict, category, claimed_by, claimed_until, assignments, created_at, updated_at, " +
  "links: [{ id, from, to, kind, target_text, origin, … }] } }"
const text = (max: number, what: string) => v.pipe(v.string(), v.minLength(1), v.maxLength(max), v.description(what))
const ahead = (what: string) =>
  v.optional(
    v.nullable(
      v.pipe(v.string(), v.minLength(1), v.description(`${what}: an ISO 8601 time or 2h, 3d from now; null clears it`)),
    ),
  )
const category = v.pipe(
  v.picklist(DEFAULT_TASK_CATEGORIES.map(({ name }) => name)),
  v.description(
    `what it is about: ${DEFAULT_TASK_CATEGORIES.map(({ name, meaning }) => `${name} (${meaning})`).join("; ")}`,
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
  category?: string
}): TaskPlan => ({
  ...(args.category === undefined ? {} : { category: args.category }),
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
        "What waits on the owner — questions nobody answered, mentions, requests, promises — oldest first. review " +
        "and serve open and close them; `source_message` is the message to read for the context.",
      input: v.object({ query: queryArgument(TASK_QUERY), limit, page }),
      annotations: { ...READ, openWorldHint: false },
      output: { entity: "task", list: true },
      stored: async (store, account, args, defaults) => {
        const { size, number, window } = paging(args, defaults)
        const query = listQuery(args.query ?? "", TASK_QUERY, "tasks list")
        const found = await tasks(store, account, defaults.guard).list({ ...window, ...(query ? { query } : {}) })
        return listOf("tasks list", { items: found.items, limit: size, has_more: found.has_more, page: number })
      },
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
        category,
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
        return itemOf(snakeKeys({ ...task, created, ...(card ? { card } : {}) }))
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
        return itemOf(
          snakeKeys(
            await tasks(store, account, defaults.guard).close(args.task, {
              as: args.as,
              by: "agent",
              ...(args.reason === undefined ? {} : { reason: args.reason }),
            }),
          ),
        )
      },
    }),

    tasks_plan: tool({
      title: "Plan a task",
      description:
        "Sets a task's title, description, due date, category and next check — when you should look at it again. The next " +
        "check is yours, not a reminder: nothing reaches the owner. Writes only to the local store; nothing is sent. " +
        `Returns ${CARD}.`,
      input: v.object({
        task: text(200, "the task's id or key, from tasks_list or tasks_agenda"),
        ...PLAN,
        category: v.optional(category),
      }),
      annotations: { ...LOCAL, destructiveHint: false, idempotentHint: true },
      stored: async (store, account, args, defaults) =>
        itemOf(snakeKeys(await tasks(store, account, defaults.guard).plan(args.task, planOf(args), "agent"))),
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
        itemOf(
          snakeKeys(
            await tasks(store, account, defaults.guard).link(
              args.task,
              { references: args.targets ?? [], chats: args.chats ?? [] },
              { kind: args.kind ?? "related-to", by: "agent" },
            ),
          ),
        ),
    }),

    tasks_show: tool({
      title: "Show a task",
      description: `One task with its plan and everything linked to it. Returns ${CARD}.`,
      input: v.object({ task: text(200, "the task's id or key") }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) =>
        itemOf(snakeKeys(await tasks(store, account, defaults.guard).show(args.task))),
    }),

    tasks_similar: tool({
      title: "Tasks like this one",
      description:
        "Open tasks, and tasks closed in the last 14 days, that may be the same job as this one: found by shared " +
        "words, the same person, the same category or one reply chain — never by the same chat alone — and scored " +
        "field by field, best first. `band` is likely, maybe or different; nothing merges on it. Returns " +
        "{ items: [{ ref, key, title, status, created_at, found_by, score, band, levels, reasons, text }] }.",
      input: v.object({
        task: text(200, "the task's id or key"),
        limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(40), v.description("how many"))),
      }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) => {
        const size = args.limit ?? 10
        const found = await tasks(store, account, defaults.guard).similar(args.task, { limit: size })
        return listOf("tasks similar", { items: found.map(snakeKeys), limit: size, has_more: false })
      },
    }),

    tasks_agenda: tool({
      title: "Today's agenda",
      description:
        "What needs a look, from the local store and without message text: open tasks overdue, due soon, due a " +
        "check, or never planned; chats where someone else wrote last and the owner has not answered (`owed`); " +
        "chats where the owner wrote last and nobody answered (`waiting`); chats that moved and whose newest " +
        "message is not stored (`unsynced`: read them first). Read only what it names. `stale` means the store " +
        "saved nothing for a day, so a chat may look quiet only because nothing was synced. `query` picks the " +
        "chats' kinds: chat_kind:channel (default chat_kind:(dialog OR group)). A task someone else claimed is " +
        "hidden unless `claimed` is true; `holder` says who you are.",
      input: v.object({
        due: span("list tasks due within this (default 1d)"),
        unanswered: span("list chats someone else wrote last in this long ago (default 1d)"),
        waiting: span("list chats the owner wrote last in this long ago (default 7d)"),
        within: span("leave out chats silent longer than this (default 30d)"),
        query: queryArgument(AGENDA_QUERY),
        claimed: v.optional(v.pipe(v.boolean(), v.description("also list tasks someone else claimed"))),
        holder: v.optional(text(200, "who you are for claims, as tasks claim --holder names you; yours stay listed")),
      }),
      annotations: { ...READ, openWorldHint: false },
      output: { entity: "agenda", list: false },
      stored: async (store, account, args, defaults) => {
        const [dueWithin, unanswered, waiting, within] = [args.due, args.unanswered, args.waiting, args.within].map(
          spanMs,
        )
        const query = listQuery(args.query ?? "", AGENDA_QUERY, "tasks agenda")
        const shown = await servicesFor(storedDeps(messenger, store, account, defaults.guard)).agenda.show({
          ...(dueWithin === undefined ? {} : { dueWithin }),
          ...(unanswered === undefined ? {} : { unanswered }),
          ...(waiting === undefined ? {} : { waiting }),
          ...(within === undefined ? {} : { within }),
          ...(query ? { query } : {}),
          claimed: args.claimed === true,
          ...(args.holder === undefined ? {} : { holder: args.holder }),
        })
        return itemOf(agendaItem(shown))
      },
    }),

    stats_tasks_show: tool({
      title: "Task statistics",
      description:
        "Per chat: how many tasks are open, when the oldest open one was opened, and the median time to close. " +
        "Returns { item: { rows: [{ chat, open, oldest_open_at, median_close_ms }] } }.",
      input: v.object({ chat: v.optional(chatOf(messenger)), type: v.optional(type) }),
      annotations: { ...READ, openWorldHint: false },
      output: { entity: "task_stats", list: false },
      stored: async (store, account, args, defaults) =>
        taskStatsAnswer(
          await tasks(store, account, defaults.guard).stats({
            ...(args.chat === undefined ? {} : { chat: args.chat }),
            ...(args.type === undefined ? {} : { type: args.type }),
          }),
          account,
        ),
    }),
  }
}
