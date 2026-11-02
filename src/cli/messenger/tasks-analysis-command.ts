import { annotate } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import { formatLocator } from "../../domain/locator.js"
import { storedChatId } from "../../services/message-resolution.js"
import { momentOf } from "../../services/moment.js"
import {
  ANALYSIS_PAGE,
  ANALYSIS_PAGE_MAX,
  acknowledgeTaskAnalysis,
  type ChatAnalysis,
  taskAnalysisList,
  unanalysedMessages,
} from "../../services/task-analysis.js"
import { TASK_QUERY } from "../../services/tasks.js"
import type { TaskAnalysisMark } from "../../store/index.js"
import { actorOf } from "../author.js"
import { destroysNothing, LOCAL_READ, LOCAL_WRITE } from "../effects.js"
import { itemOf, renderAnswer } from "../envelope.js"
import { listQuery, pagedList, pageOf, typedQuery } from "../list-query.js"
import { positiveCount } from "../paging.js"
import { nextStep } from "../steps.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"

const when = (at: string | null) => (at === null ? "—" : at.slice(0, 16).replace("T", " "))

const sinceOf = (typed: string | undefined) =>
  typed === undefined ? undefined : new Date(momentOf(typed, "--since-time")).toISOString()

const markItem = (mark: TaskAnalysisMark) => ({
  chat: mark.chatId,
  from: mark.from,
  through: mark.through,
  through_id: mark.throughId,
  by: mark.by,
  checked_at: mark.checkedAt,
  checked_through: mark.checkedThrough,
  at: mark.at,
})

const analysisItem = (chat: ChatAnalysis) => ({
  chat: chat.chatId,
  title: chat.title,
  kind: chat.kind,
  newest_at: chat.newestAt,
  mark: chat.mark === null ? null : markItem(chat.mark),
  waiting: chat.waiting,
  late: chat.late,
  untrusted: ["title"],
})

/**
 * Each chat's own point of reading for tasks (`../../services/task-analysis.ts`): how far it was read, what waits, and
 * the step that moves it. Apart from `inbox --new`, `review --new` and the messenger's read state, which other
 * readers move.
 */
export const analysisCommands = (tasks: Command, messenger: Messenger): void => {
  const tool = messenger.app.command
  annotate(tasks.command("status"), {
    output: { entity: "task_analysis" },
    effects: LOCAL_READ,
    examples: [`${tool} personal tasks status`],
  })
    .summary("how far each chat was read for tasks, and how much waits")
    .description(
      "every chat that can hold your tasks — not a channel or Saved Messages — with the point its messages were read " +
        "for tasks through, who read them, how many stored messages wait after it, and how many arrived late inside " +
        "the stretch already read (history fetched afterwards). Its own point: reading a chat, marking it read, " +
        "inbox --new and review --new never move it; tasks acknowledge does. Reads only the local store",
    )
    .option("--limit <n>", "how many chats", positiveCount("--limit"))
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const { limit, offset } = pageOf(context.settings)
      const chats = await context.withStore((store, account) => taskAnalysisList(store, account), {
        name: "tasks status",
      })
      const shown = chats.slice(offset, offset + limit)
      renderAnswer(
        this,
        context,
        pagedList("tasks status", context.settings, {
          items: shown.map(analysisItem),
          has_more: chats.length > offset + limit,
        }),
        () =>
          shown.length === 0
            ? ""
            : `${shown
                .map(
                  (one) =>
                    `${(one.title ?? one.chatId).slice(0, 30).padEnd(30)}  read through ${when(one.mark?.through ?? null)}` +
                    `  ${one.waiting} waiting${one.late > 0 ? `, ${one.late} late` : ""}`,
                )
                .join("\n")}\n`,
      )
    })

  annotate(tasks.command("review"), {
    output: { entity: "task_review" },
    effects: LOCAL_READ,
    examples: [`${tool} personal tasks review <chat>`, `${tool} personal tasks review <chat> --since-time 30d`],
  })
    .summary("a chat's stored messages not yet read for tasks, with its open tasks")
    .description(
      "the stored messages after the chat's task point, oldest first, and the chat's open tasks, so one read can open " +
        "new tasks and update or close the old ones. A chat never read starts 14 days back. Moves nothing: when done, " +
        "tasks acknowledge <chat> <through> records it. Reads only the local store; messages sync or backfill fetch " +
        "what it lacks",
    )
    .argument("<chat>", messenger.chatArgument)
    .option(
      "--limit <n>",
      `how many messages (default ${ANALYSIS_PAGE}, ${ANALYSIS_PAGE_MAX} with --since-time; at most ${ANALYSIS_PAGE_MAX})`,
      positiveCount("--limit"),
    )
    .option("--since-time <time>", "read again from this ISO 8601 time, or 30d ago, whatever the point says")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { sinceTime, ...options } = this.opts<{ limit?: number; sinceTime?: string }>()
      const since = sinceOf(sinceTime)
      // A read again clears late messages only when one acknowledge covers the whole stretch, so it takes one page.
      const limit = options.limit ?? (since === undefined ? ANALYSIS_PAGE : ANALYSIS_PAGE_MAX)
      const { id, page, sourceOf } = await context.withStore(
        async (store, account) => {
          const id = await storedChatId(messenger, chat, store, account, { includeLeft: true })
          return {
            id,
            page: await unanalysedMessages(store, account, id, {
              limit: Math.min(limit, ANALYSIS_PAGE_MAX),
              ...(since === undefined ? {} : { since }),
            }),
            sourceOf: (message: string) => formatLocator({ ...account, chat: id, message }),
          }
        },
        { name: "tasks review" },
      )
      const open = await context.withServices((services) =>
        services.tasks.list({
          query: listQuery(typedQuery([`chat:${JSON.stringify(id)}`, "state:open"]), TASK_QUERY, "tasks review"),
          limit: 100,
          offset: 0,
        }),
      )
      const last = page.messages.at(-1)
      renderAnswer(
        this,
        context,
        itemOf(
          {
            chat: id,
            from: page.from,
            mark: page.mark === null ? null : markItem(page.mark),
            late: page.late,
            has_more: page.more,
            through: last ? sourceOf(last.id) : null,
            messages: page.messages.map((one) => ({
              ref: sourceOf(one.id),
              at: one.timestamp,
              sender: one.senderName,
              outgoing: one.outgoing === true,
              reply_to: one.replyTo?.id ?? one.replyToId ?? null,
              text: one.text,
            })),
            open_tasks: open.items.map(({ key = null, kind, title, source_message }) => ({
              key,
              kind,
              title,
              source: source_message,
            })),
            untrusted: ["messages.text", "messages.sender"],
          },
          {
            next:
              last && !(since !== undefined && page.more)
                ? [
                    nextStep("tasks.acknowledge", {
                      args: { chat: id, message: last.id, since_time: since },
                      values: { shown: page.messages.length },
                    }),
                  ]
                : [],
          },
        ),
        () =>
          [
            `from ${when(page.from)}: ${page.messages.length} message(s)${page.more ? ", more after them" : ""}` +
              (page.late > 0
                ? `; ${page.late} arrived late inside the stretch read: --since-time ${page.mark?.from} reads it again`
                : ""),
            ...page.messages.map(
              (one) =>
                `  ${when(one.timestamp)}  ${one.outgoing ? "you" : (one.senderName ?? "?")}: ${one.text.replace(/\s+/g, " ").slice(0, 100)}`,
            ),
            `open tasks (${open.items.length})`,
            ...open.items.map((task) => `  ${task.key}  ${task.kind}  ${task.title ?? ""}`),
            ...(since !== undefined && page.more
              ? [
                  `this read again does not reach the point in one page: acknowledging it moves nothing and late ` +
                    "messages stay until a later version pages a read again (tell the owner)",
                ]
              : last
                ? [`done reading: ${tool} tasks acknowledge ${id} ${last.id}`]
                : []),
            "",
          ].join("\n"),
      )
    })

  destroysNothing(
    annotate(tasks.command("acknowledge"), {
      output: { entity: "task_analysis_mark" },
      effects: LOCAL_WRITE,
      examples: [`${tool} personal tasks acknowledge <chat> <message>`],
    }),
  )
    .summary("record that a chat was read for tasks through a message")
    .description(
      "moves the chat's task point to this message once its tasks are opened, updated or closed; it never moves " +
        "back. With --since-time, the read started there: a read again from the start of the stretch clears what " +
        "arrived late inside it",
    )
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the id of the last message read, as tasks review shows it")
    .option("--since-time <time>", "where the read started, when tasks review was given --since-time")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "tasks.acknowledge")
      const { sinceTime } = this.opts<{ sinceTime?: string }>()
      const since = sinceOf(sinceTime)
      const by = actorOf(this)
      const { mark, moved } = await context.withStore(
        async (store, account) => {
          const id = await storedChatId(messenger, chat, store, account, { includeLeft: true })
          return acknowledgeTaskAnalysis(store, account, id, message, { by, ...(since === undefined ? {} : { since }) })
        },
        { name: "tasks acknowledge" },
      )
      renderAnswer(this, context, itemOf({ ...markItem(mark), moved }), () =>
        moved
          ? `read for tasks from ${when(mark.from)} through ${when(mark.through)}\n`
          : `already read through ${when(mark.through)}; the point stays\n`,
      )
    })
}
