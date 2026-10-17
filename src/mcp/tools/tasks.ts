import * as v from "valibot"
import { holderOf } from "../../cli/author.js"
import { itemOf, listOf, snakeKeys } from "../../cli/envelope.js"
import { listQuery, queryArgument, queryTerms } from "../../cli/list-query.js"
import type { Messenger } from "../../cli/messenger/context.js"
import { taskStatsAnswer } from "../../cli/messenger/stats-answers.js"
import type { SendGuard } from "../../sends/guard.js"
import { AGENDA_QUERY, agendaItem } from "../../services/agenda.js"
import { servicesFor, storedDeps } from "../../services/index.js"
import { storedChatId } from "../../services/message-resolution.js"
import { aheadOf, momentOf } from "../../services/moment.js"
import { DEFAULT_TASK_CATEGORIES } from "../../services/task-categories.js"
import { ARRIVAL_WINDOW, applyTaskRulesToChats } from "../../services/task-rules.js"
import {
  CLAIM_LEASE_MS,
  type PairDecision,
  TASK_LINK_KINDS,
  TASK_PAIR_QUERY,
  TASK_QUERY,
  type TaskPlan,
} from "../../services/tasks.js"
import type { AccountKey, MessageStore } from "../../store/store.js"
import { TASK_KINDS } from "../../tasks/index.js"
import { type AnyTool, chatOf, limit, page, paging, READ, tool } from "../tool.js"

const LOCAL = { readOnlyHint: false, openWorldHint: false }
const ROW =
  "{ item: { id, key, source, source_kind, account, group, kind, category, state, reason?, origin, created_at, due_at?, " +
  "closed_at?, closed_by?, message: { sender_name, text, timestamp } | null, note?: { id, title, text, updated_at } | null } }"
const ROW_CLOSED =
  "{ item: { id, key, state, kind, reason?, closed_at?, closed_by?, close_certainty, close_suggestion: { as, by, " +
  "certainty, reason, at } | null, … } } — state open with close_suggestion set means the close waits on the owner"
const type = v.picklist(TASK_KINDS)
const CARD =
  "{ item: { id, ref, key, project, title, description, type, status, priority, parent, source, due_at, " +
  "next_check_at, closed_at, reason, verdict, category, claimed_by, claimed_until, close_certainty, close_suggestion, " +
  "assignments, created_at, updated_at, " +
  "links: [{ id, from, to, kind, target_text, origin, … }], " +
  "linked_from: [{ id, from, to, kind, … }] — other tasks' relations to this one, as a follow-up-of } }"
const text = (max: number, what: string) => v.pipe(v.string(), v.minLength(1), v.maxLength(max), v.description(what))
const ahead = (what: string) =>
  v.optional(
    v.nullable(
      v.pipe(v.string(), v.minLength(1), v.description(`${what}: an ISO 8601 time or 2h, 3d from now; null clears it`)),
    ),
  )
// The owner edits the list (the shared config file, or config set task_categories.*), so the store checks the name.
// Names only: with each meaning the default list is ~1.9k characters in two tool schemas; tasks_categories has them.
const category = text(
  30,
  "what it is about, a name from tasks_categories (it says what each means) — by default " +
    DEFAULT_TASK_CATEGORIES.map(({ name }) => name).join(", "),
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
  remind_time: ahead("when to look at it again"),
}
const planOf = (args: {
  title?: string
  description?: string | null
  due?: string | null
  remind_time?: string | null
  category?: string
}): TaskPlan => ({
  ...(args.category === undefined ? {} : { category: args.category }),
  ...(args.title === undefined ? {} : { title: args.title }),
  ...(args.description === undefined ? {} : { description: args.description }),
  ...(args.due === undefined ? {} : { dueAt: args.due === null ? null : new Date(aheadOf(args.due, "due")) }),
  ...(args.remind_time === undefined
    ? {}
    : { nextCheckAt: args.remind_time === null ? null : new Date(aheadOf(args.remind_time, "remind_time")) }),
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
        "false`). When an open task may be the same job it refuses (reason task.duplicate-candidates) and " +
        "lists up to 5 in `candidates` with score and reasons: read them, then call again with `into` (that task's " +
        "key: the message is linked to it, no task opens) or `new: true` (open it anyway). When only tasks closed in " +
        "the last 14 days match, it opens the task and links it follow-up-of the best one, which stays closed " +
        "(`follow_up_of`); new: true does the same. Writes only to the local store; nothing is sent. After into, the " +
        "task now reads that message too, so tasks it may duplicate go to tasks_duplicates. Returns " +
        `${ROW} with created, follow_up_of { ref, key, title, status } when it follows one up and, after into, ` +
        "attached and review (how many pairs went there).",
      input: v.object({
        message: v.pipe(v.string(), v.minLength(1), v.description("a msg: locator or note:<id>")),
        type,
        category,
        ...PLAN,
        into: v.optional(text(200, "a listed candidate's key: link the message to it instead of opening a task")),
        new: v.optional(v.pipe(v.boolean(), v.description("open the task although candidates were listed"))),
      }),
      annotations: { ...LOCAL, destructiveHint: false, idempotentHint: true },
      stored: async (store, account, args, defaults) => {
        const { task, created, attached, review, followUpOf, card } = await tasks(store, account, defaults.guard).add(
          args.message,
          args.type,
          "agent",
          planOf(args),
          { ...(args.into === undefined ? {} : { attach: args.into }), ...(args.new ? { new: true } : {}) },
        )
        return itemOf(
          snakeKeys({
            ...task,
            created,
            ...(attached ? { attached, review } : {}),
            ...(followUpOf ? { followUpOf } : {}),
            ...(card ? { card } : {}),
          }),
        )
      },
    }),

    tasks_close: tool({
      title: "Close a task",
      description:
        "Closes a task as done, or as dismissed when it needs no answer; `reason` is kept with it. State your " +
        "`certainty` that the task needs nothing more: when the owner allows agent closes and it is at least the " +
        "owner's threshold (config task_agent_close_min, default 0.8), the task closes; otherwise it stays open " +
        "with `close_suggestion` set, and the owner confirms or refuses it — do not ask again. A closed task stays " +
        "closed, and the rules never reopen it; only tasks_unmerge reopens a merged one. Writes only to the local " +
        `store; nothing is sent. Returns ${ROW_CLOSED}.`,
      input: v.object({
        task: v.pipe(v.string(), v.minLength(1), v.description("the task's id or key, from tasks_list")),
        as: v.picklist(["done", "dismissed"]),
        certainty: v.pipe(
          v.number(),
          v.minValue(0),
          v.maxValue(1),
          v.description(
            "how sure you are, 0 to 1, that the task needs nothing more; be honest — below the threshold the owner decides",
          ),
        ),
        reason: v.optional(v.pipe(v.string(), v.minLength(1), v.description("why — no-reply-needed, for example"))),
      }),
      annotations: { ...LOCAL, destructiveHint: false, idempotentHint: false },
      stored: async (store, account, args, defaults) => {
        return itemOf(
          snakeKeys(
            await tasks(store, account, defaults.guard).close(args.task, {
              as: args.as,
              by: "agent",
              certainty: args.certainty,
              ...(args.reason === undefined ? {} : { reason: args.reason }),
            }),
          ),
        )
      },
    }),

    tasks_plan: tool({
      title: "Plan a task",
      description:
        "Sets a task's title, description, due date, category and remind_time — when you should look at it again " +
        "(next_check_at). It is yours: nothing reaches the owner. Writes only to the local store; nothing is sent. " +
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
        "document:<id>, note:<id>, or a URL. A message the store has not saved yet is kept as written. A linked " +
        "message is read when tasks are compared, so after a msg: target the tasks this one may now duplicate go to " +
        "tasks_duplicates and `review` counts them; the link stands either way. Writes only to the local store; " +
        `nothing is sent. Returns ${CARD}, with review after a msg: target.`,
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

    tasks_related: tool({
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
        return listOf("tasks related", { items: found.map(snakeKeys), limit: size, has_more: false })
      },
    }),

    tasks_duplicates: tool({
      title: "Pairs to review",
      description:
        "Pairs of tasks a rule opened that may be one job, newest first: `task` is the newer one, `other` the one it " +
        "may duplicate, with score, band, levels and reasons. Decide each: tasks_merge when they are one job, " +
        "tasks_duplicates_reject when they are not, tasks_duplicates_defer when the meaning cannot tell — the owner " +
        "then lists it with query decision:unsure. Returns { items: [{ task, source, other, score, band, levels, reasons, " +
        "decision, decided_at, created_at }] }.",
      input: v.object({
        query: queryArgument(TASK_PAIR_QUERY),
        limit,
        page,
      }),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults) => {
        const { size, number, window } = paging(args, defaults)
        const rows = await tasks(store, account, defaults.guard).duplicates({
          decision: queryTerms(args.query ?? "", TASK_PAIR_QUERY, "tasks duplicates").get("decision") as PairDecision,
          limit: window.limit + 1,
          offset: window.offset,
        })
        return listOf("tasks duplicates", {
          items: rows.slice(0, window.limit).map(snakeKeys),
          limit: size,
          has_more: rows.length > window.limit,
          page: number,
        })
      },
    }),

    tasks_duplicates_reject: tool({
      title: "Not the same job",
      description:
        "Records that two tasks are different jobs: the pair leaves the review list and is never offered again. " +
        "Writes only to the local store. Returns { item: pair }.",
      input: v.object({ dup: text(200, "the task listed as `task`"), task: text(200, "the task listed as `other`") }),
      annotations: { ...LOCAL, destructiveHint: false, idempotentHint: true },
      stored: async (store, account, args, defaults) =>
        itemOf(
          snakeKeys(
            await tasks(store, account, defaults.guard).decideDuplicate(args.dup, args.task, "rejected", "agent"),
          ),
        ),
    }),

    tasks_duplicates_defer: tool({
      title: "Leave a pair to the owner",
      description:
        "Marks a pair the fields and the text cannot decide — a gift for mum or for dad — so the owner decides it; " +
        "it leaves your list and shows under tasks_duplicates with query decision:unsure. Writes only to the local store. " +
        "Returns { item: pair }.",
      input: v.object({ dup: text(200, "the task listed as `task`"), task: text(200, "the task listed as `other`") }),
      annotations: { ...LOCAL, destructiveHint: false, idempotentHint: true },
      stored: async (store, account, args, defaults) =>
        itemOf(
          snakeKeys(
            await tasks(store, account, defaults.guard).decideDuplicate(args.dup, args.task, "unsure", "agent"),
          ),
        ),
    }),

    tasks_merge: tool({
      title: "Merge a duplicate task",
      description:
        "One job seen twice: links every message of `dup` to `into`, closes `dup` dismissed with a duplicate-of " +
        "relation, and records the decision. Nothing is deleted; tasks_unmerge undoes it. Writes only to the local " +
        "store. Returns { item: { pair, linked, review, task } }: `linked` counts the messages added to `into`, " +
        "`review` the pairs its new messages sent to tasks_duplicates, `task` is its card.",
      input: v.object({
        dup: text(200, "the duplicate's key; it must be open"),
        into: text(200, "the task that stays"),
      }),
      annotations: { ...LOCAL, destructiveHint: false, idempotentHint: false },
      stored: async (store, account, args, defaults) =>
        itemOf(snakeKeys(await tasks(store, account, defaults.guard).merge(args.dup, args.into, "agent"))),
    }),

    tasks_unmerge: tool({
      title: "Undo a merge",
      description:
        "Reopens a merged task and removes its duplicate-of relation; the messages the merge linked stay linked. " +
        "Writes only to the local store. Returns { item: { pair, task } }.",
      input: v.object({ dup: text(200, "the merged task's key") }),
      annotations: { ...LOCAL, destructiveHint: false, idempotentHint: false },
      stored: async (store, account, args, defaults) =>
        itemOf(snakeKeys(await tasks(store, account, defaults.guard).unmerge(args.dup, "agent"))),
    }),

    tasks_categories: tool({
      title: "Task categories",
      description:
        "The categories a task takes, with what each means and the words a rule picks it by. The owner edits the list " +
        "in `file` (its task_categories section) or with config set task_categories.<name>; tasks_add and tasks_plan " +
        "refuse a name not on it. `unlisted` names the " +
        "categories tasks still carry after they left the list; tasks_plan moves such a task to a listed one. " +
        "Returns { item: { categories: [{ name, meaning, triggers }], unlisted: [{ name, open, total }], file } }.",
      input: v.object({}),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, _args, defaults) => {
        const service = tasks(store, account, defaults.guard)
        const list = await service.categories()
        return itemOf({
          categories: list.map(({ name, meaning, triggers }) => ({ name, meaning, triggers })),
          unlisted: await service.unlistedCategories(),
          file: (await service.categoriesFile()) ?? null,
        })
      },
    }),

    tasks_apply: tool({
      title: "Build tasks from a chat's history",
      description:
        "The task rules over a chat's newest stored messages: a question nobody answered and a mention of the owner " +
        "open a task, the owner's answer closes one. A first sync opens none from history (config " +
        "task_first_pass_per_chat, 0 by default): ask the owner before building a chat's tasks. Without yes it " +
        "changes nothing and lists what would open; with yes it opens them through the duplicate check. Reads only " +
        "the local store. Returns { items: [{ chat, messages, added, closed, review, tasks: [{ source, kind, " +
        "category }] }] }.",
      input: v.object({
        chats: v.pipe(v.array(chatOf(messenger)), v.minLength(1), v.maxLength(20)),
        last: v.optional(
          v.pipe(
            v.number(),
            v.integer(),
            v.minValue(1),
            v.maxValue(1000),
            v.description(`read the newest n stored messages of each chat (default ${ARRIVAL_WINDOW})`),
          ),
        ),
        yes: v.optional(v.pipe(v.boolean(), v.description("open the tasks instead of listing them"))),
      }),
      annotations: { ...LOCAL, destructiveHint: false, idempotentHint: true },
      stored: async (store, account, args) => {
        const ids = []
        for (const chat of args.chats) ids.push(await storedChatId(messenger, chat, store, account))
        const passes = await applyTaskRulesToChats(store, account, ids, {
          ...(args.last === undefined ? {} : { last: args.last }),
          yes: args.yes ?? false,
        })
        return listOf("tasks apply", { items: passes.map(snakeKeys), limit: passes.length, has_more: false })
      },
    }),

    tasks_claim: tool({
      title: "Claim a task",
      description:
        "Takes an open task so no other agent works it at once; the claim lapses by itself (default 30m), and " +
        "claiming again extends your own. Refused, naming the holder and until when (reason task.claimed), while " +
        "someone else holds it. `holder` is who you are — a session or chat id; left out, WIRECAT_HOLDER, else " +
        `Claude Code's session, else the agent's name. Writes only to the local store. Returns ${CARD}.`,
      input: v.object({
        task: text(200, "the task's id or key"),
        lease: span("how long the claim lasts (default 30m)"),
        holder: v.optional(text(200, "who you are for claims: a session or chat id")),
      }),
      annotations: { ...LOCAL, destructiveHint: false, idempotentHint: true },
      stored: async (store, account, args, defaults) =>
        itemOf(
          snakeKeys(
            await tasks(store, account, defaults.guard).claim(
              args.task,
              holderOf(defaults.env, args.holder),
              spanMs(args.lease) ?? CLAIM_LEASE_MS,
            ),
          ),
        ),
    }),

    tasks_release: tool({
      title: "Release a task",
      description:
        "Gives back a task you claimed, before the claim lapses; only its holder or the owner may. Writes only to " +
        `the local store. Returns ${CARD}.`,
      input: v.object({
        task: text(200, "the task's id or key"),
        holder: v.optional(text(200, "who you are for claims, as tasks_claim named you")),
      }),
      annotations: { ...LOCAL, destructiveHint: false, idempotentHint: true },
      stored: async (store, account, args, defaults) =>
        itemOf(
          snakeKeys(
            await tasks(store, account, defaults.guard).release(args.task, holderOf(defaults.env, args.holder)),
          ),
        ),
    }),

    tasks_agenda: tool({
      title: "Today's agenda",
      description:
        "What needs a look, from the local store and without message text: open tasks overdue, due soon, due a " +
        "check, or never planned; chats where someone else wrote last and the owner has not answered (`owed`); " +
        "chats where the owner wrote last and nobody answered (`waiting`); chats that moved and whose newest " +
        "message is not stored (`unsynced`: read them first). Read only what it names. `stale` means the store " +
        "saved nothing for a day, so a chat may look quiet only because nothing was synced. `query` narrows " +
        "the chats by chat_kind:channel (default chat_kind:(dialog OR group)) and the tasks by tag:, category: and " +
        "claimed:none|mine|others|any (default claimed:(none OR mine)); `holder` says who you are.",
      input: v.object({
        due_within: span("list tasks due within this (default 1d)"),
        unanswered: span("list chats someone else wrote last in this long ago (default 1d)"),
        waiting: span("list chats the owner wrote last in this long ago (default 7d)"),
        within: span("leave out chats silent longer than this (default 30d)"),
        query: queryArgument(AGENDA_QUERY),
        holder: v.optional(text(200, "who you are for claims, as tasks claim --holder names you; yours stay listed")),
      }),
      annotations: { ...READ, openWorldHint: false },
      output: { entity: "agenda", list: false },
      stored: async (store, account, args, defaults) => {
        const [dueWithin, unanswered, waiting, within] = [
          args.due_within,
          args.unanswered,
          args.waiting,
          args.within,
        ].map(spanMs)
        const query = listQuery(args.query ?? "", AGENDA_QUERY, "tasks agenda")
        const shown = await servicesFor(storedDeps(messenger, store, account, defaults.guard)).agenda.show({
          ...(dueWithin === undefined ? {} : { dueWithin }),
          ...(unanswered === undefined ? {} : { unanswered }),
          ...(waiting === undefined ? {} : { waiting }),
          ...(within === undefined ? {} : { within }),
          ...(query ? { query } : {}),
          holder: holderOf(defaults.env, args.holder),
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
