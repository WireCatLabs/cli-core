import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { AGENDA_QUERY, type Agenda, agendaItem } from "../../services/agenda.js"
import { aheadOf, momentOf } from "../../services/moment.js"
import { taskCategoryOf } from "../../services/task-categories.js"
import {
  CLAIM_LEASE_MS,
  closedStateOf,
  TASK_QUERY,
  type TaskCard,
  type TaskLinkOptionKind,
  type TaskPlan,
  type TaskView,
  taskLinkKindOf,
  taskTypeOf,
} from "../../services/tasks.js"
import { authorOf } from "../author.js"
import { environmentOf } from "../context.js"
import { LOCAL_READ, LOCAL_WRITE } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { listQuery, pagedList, pageOf, typedQuery, withQuery } from "../list-query.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"
import { refuseJsonl, taskStatsAnswer } from "./stats-answers.js"

const line = ({ id, key, state, kind, group, createdAt, message, note }: TaskView) =>
  [
    key ?? id.slice(0, 8),
    state.padEnd(9),
    kind.padEnd(8),
    group,
    createdAt.toISOString().slice(0, 16).replace("T", " "),
    note
      ? `${note.title ?? "Note"}: ${note.text.replace(/\s+/g, " ").slice(0, 80)}`
      : message
        ? `${message.senderName ?? "?"}: ${message.text.replace(/\s+/g, " ").slice(0, 80)}`
        : "(not in the store)",
  ].join("  ")

const when = (at: string | null) => (at === null ? "—" : at.slice(0, 16).replace("T", " "))

const card = (task: TaskCard) =>
  [
    `${task.key}  ${task.status}  ${task.type}  ${task.category ?? "—"}  ${task.title}`,
    `due ${when(task.dueAt)}  next check ${when(task.nextCheckAt)}  source ${task.source ?? "—"}`,
    ...(task.claimedBy === null ? [] : [`claimed by ${task.claimedBy} until ${when(task.claimedUntil)}`]),
    ...(task.description ? ["", task.description, ""] : []),
    ...task.links.map((link) => `${link.kind.padEnd(12)} ${link.to ?? link.targetText ?? "?"}`),
  ].join("\n")

const agendaText = (agenda: Agenda) => {
  const chat = (one: Agenda["owed"][number]) =>
    `  ${when(one.lastMessageAt)}  ${one.title ?? one.chatId}  ${one.lastMessage ?? one.chatId}` +
    (one.openTasks.length > 0 ? `  (${one.openTasks.length} open)` : "")
  return [
    ...(agenda.stale
      ? [`the store saved nothing since ${when(agenda.storedAt)}: sync before trusting quiet chats`]
      : []),
    `tasks (${agenda.tasks.length})`,
    ...agenda.tasks.map(
      (task) => `  ${task.key}  ${task.reasons.join(",").padEnd(9)}  due ${when(task.dueAt)}  ${task.title}`,
    ),
    `owed — they wrote last (${agenda.owed.length})`,
    ...agenda.owed.map(chat),
    `waiting — you wrote last (${agenda.waiting.length})`,
    ...agenda.waiting.map(chat),
    `unsynced — moved, newest message not stored: read before judging (${agenda.unsynced.length})`,
    ...agenda.unsynced.map(chat),
  ].join("\n")
}

/** `none` clears a date; anything else is a time ahead. Not `null`: commander stores a parser's `null` as "". */
const dateOrNone = (flag: string) => (typed: string) =>
  typed.trim().toLowerCase() === "none" ? ("none" as const) : new Date(aheadOf(typed, flag))

const durationOf = (flag: string) => (typed: string) => {
  const wanted = typed.trim()
  const ms = Date.now() - momentOf(wanted, flag)
  if (!/^\d+(m|h|d)$/.test(wanted))
    throw new CliError("validation_error", `${flag} takes 30m, 2h, 7d — not "${wanted}"`)
  return ms
}

const planOptions = (command: Command, verb: string) =>
  command
    .option("--title <text>", `one line: the action and its object — ${verb}`)
    .option("--description <text>", "the detail, in Markdown: who owes whom, done when, next step, keywords")
    .option(
      "--due <when>",
      "when it must be done: an ISO 8601 time or 2h, 3d from now; none clears it",
      dateOrNone("--due"),
    )
    .option(
      "--check <when>",
      "when to look at it again: an ISO 8601 time or 2h, 3d from now; none clears it",
      dateOrNone("--check"),
    )

const categoryHelp = "what it is about, from the list tasks categories prints: money, documents, meeting, …"

/** Who claims: the agent whose terminal runs the tool, else the owner — as mentions records its author. */
const holderOf = (command: Command) => authorOf(environmentOf(command).env ?? process.env)

const planFrom = (options: {
  title?: string
  description?: string
  due?: Date | "none"
  check?: Date | "none"
  category?: string
}) => {
  const plan: TaskPlan = {}
  if (options.category !== undefined) plan.category = options.category
  if (options.title !== undefined) plan.title = options.title
  if (options.description !== undefined) plan.description = options.description
  if (options.due !== undefined) plan.dueAt = options.due === "none" ? null : options.due
  if (options.check !== undefined) plan.nextCheckAt = options.check === "none" ? null : options.check
  return plan
}

/** What waits on the owner — kept in the local store by `src/tasks/`; nothing here reaches the messenger. */
export const tasksCommand = (messenger: Messenger): Command => {
  const tasks = new Command("tasks").description(
    "what waits on you — unanswered questions, mentions, requests, promises — kept in the local store; review and serve add them",
  )

  withQuery(
    annotate(tasks.command("list"), { effects: LOCAL_READ }).description(
      "tasks, oldest first, with their message or note source",
    ),
    TASK_QUERY,
  )
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .action(async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger)
      const query = listQuery(typedQuery(words), TASK_QUERY, "tasks list")
      const { limit, offset } = pageOf(context.settings)
      const found = await context.withServices((services) =>
        services.tasks.list({
          ...(query ? { query } : {}),
          limit,
          offset,
          previews: context.format === "pretty",
        }),
      )
      renderAnswer(this, context, pagedList("tasks list", context.settings, found), () =>
        found.items.length === 0 ? "" : `${(found.previews ?? []).map(line).join("\n")}\n`,
      )
      if (found.items.length === 0 && context.format === "pretty")
        context.renderer.note("no tasks — review and serve add them as questions arrive")
    })

  planOptions(
    annotate(tasks.command("add"), { effects: LOCAL_WRITE })
      .description("add a task for a stored message or note — a promise, a request")
      .argument("<message>", "a message locator, msg:<provider>/<account>/<chat>/<message>, or note:<id>")
      .requiredOption("--type <name>", "the task's type: question, request, mention or promise", taskTypeOf)
      .requiredOption("--category <name>", categoryHelp, taskCategoryOf()),
    "send Alex the API token",
  ).action(async function (this: Command, message: string) {
    const context = messengerContext(this, messenger)
    refuseLocalWrite(context, messenger.app.command, "tasks.add")
    const options = this.opts<{
      type: TaskView["kind"]
      category: string
      title?: string
      description?: string
      due?: Date | "none"
    }>()
    const plan = planFrom(options)
    const {
      task,
      created,
      card: planned,
    } = await context.withServices((services) => services.tasks.add(message, options.type, "owner", plan))
    renderAnswer(
      this,
      context,
      itemOf(snakeKeys({ ...task, created, ...(planned ? { card: planned } : {}) })),
      () => `${planned ? card(planned) : line(task)}\n`,
    )
    if (!created && context.format === "pretty")
      context.renderer.note("this source already has a task — that one is shown, unchanged")
  })

  planOptions(
    annotate(tasks.command("plan"), { effects: LOCAL_WRITE })
      .description("set a task's title, description, due date, next check and category; nothing reaches the messenger")
      .argument("<task>", "the task's id or key, as tasks list shows it")
      .option("--category <name>", `${categoryHelp}; a change is kept in the task's history`, taskCategoryOf()),
    "send Alex the API token",
  ).action(async function (this: Command, id: string) {
    const context = messengerContext(this, messenger)
    refuseLocalWrite(context, messenger.app.command, "tasks.plan")
    const plan = planFrom(this.opts())
    if (Object.keys(plan).length === 0)
      throw new CliError("validation_error", "give at least one of --title, --description, --due, --check, --category")
    const planned = await context.withServices((services) => services.tasks.plan(id, plan, "owner"))
    renderAnswer(this, context, itemOf(snakeKeys(planned)), () => `${card(planned)}\n`)
  })

  annotate(tasks.command("link"), { effects: LOCAL_WRITE })
    .description("link a task to messages, chats, people or URLs — or to another task: task:<id>")
    .argument("<task>", "the task's id or key, as tasks list shows it")
    .argument(
      "[targets...]",
      "msg: locators, person:<id>, document:<id>, note:<id>, a URL; or task:<id>, which links two project tasks",
    )
    .option(
      "--chat <chat>",
      `a chat it concerns, repeatable; ${messenger.chatArgument}`,
      (value: string, all: string[] = []) => [...all, value],
    )
    .option(
      "--kind <kind>",
      "related-to (default), evidence — it shows the task is real — or created-from; for task:<id>, related-to, " +
        "blocked-by, follow-up-of, duplicate-of or discovered-from",
      taskLinkKindOf,
    )
    .action(async function (this: Command, id: string, targets: string[]) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "tasks.link")
      const { chat = [], kind = "related-to" } = this.opts<{ chat?: string[]; kind?: TaskLinkOptionKind }>()
      if (targets.length === 0 && chat.length === 0) throw new CliError("validation_error", "give a target or --chat")
      const linked = await context.withServices((services) =>
        services.tasks.link(id, { references: targets, chats: chat }, { kind, by: "owner" }),
      )
      renderAnswer(this, context, itemOf(snakeKeys(linked)), () =>
        "relations" in linked
          ? `${linked.relations.map((one) => `${one.from} ${one.kind} ${one.to}`).join("\n")}\n`
          : `${card(linked)}\n`,
      )
    })

  annotate(tasks.command("show"), { effects: LOCAL_READ })
    .description("one task: its plan and everything linked to it")
    .argument("<task>", "the task's id or key, as tasks list shows it")
    .action(async function (this: Command, id: string) {
      const context = messengerContext(this, messenger)
      const shown = await context.withServices((services) => services.tasks.show(id))
      renderAnswer(this, context, itemOf(snakeKeys(shown)), () => `${card(shown)}\n`)
    })

  withQuery(
    annotate(tasks.command("agenda"), { effects: LOCAL_READ }).description(
      "what needs a look today, from the local store and without message text: tasks overdue, due or to check, " +
        "chats where you owe an answer, chats where you wait for one",
    ),
    AGENDA_QUERY,
  )
    .option("--due <span>", "list tasks due within this: 30m, 2h, 1d (default 1d)", durationOf("--due"))
    .option(
      "--unanswered <span>",
      "list chats where someone else wrote last this long ago (default 1d)",
      durationOf("--unanswered"),
    )
    .option("--waiting <span>", "list chats where you wrote last this long ago (default 7d)", durationOf("--waiting"))
    .option(
      "--within <span>",
      "leave out chats silent longer than this: they ended (default 30d)",
      durationOf("--within"),
    )
    .option("--claimed", "also list tasks someone else holds (tasks claim); hidden by default")
    .action(async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger)
      const options = this.opts<{
        due?: number
        unanswered?: number
        waiting?: number
        within?: number
        claimed?: boolean
      }>()
      const query = listQuery(typedQuery(words), AGENDA_QUERY, "tasks agenda")
      const agenda = await context.withServices((services) =>
        services.agenda.show({
          ...(options.due === undefined ? {} : { dueWithin: options.due }),
          ...(options.unanswered === undefined ? {} : { unanswered: options.unanswered }),
          ...(options.waiting === undefined ? {} : { waiting: options.waiting }),
          ...(options.within === undefined ? {} : { within: options.within }),
          ...(query ? { query } : {}),
          holder: holderOf(this),
          claimed: options.claimed === true,
        }),
      )
      renderAnswer(this, context, itemOf(agendaItem(agenda)), () => `${agendaText(agenda)}\n`)
    })

  annotate(tasks.command("categories"), { effects: LOCAL_READ })
    .description("the categories a task takes, with what each means and the words a rule picks it by")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const list = await context.withServices(async (services) => services.tasks.categories())
      const items = list.map(({ name, meaning, triggers }) => ({ name, meaning, triggers }))
      renderAnswer(
        this,
        context,
        itemOf({ categories: items }),
        () => `${items.map(({ name, meaning }) => `${name.padEnd(10)} ${meaning}`).join("\n")}\n`,
      )
    })

  annotate(tasks.command("claim"), { effects: LOCAL_WRITE })
    .description("take an open task so no other agent works it at once; the claim lapses by itself")
    .argument("<task>", "the task's id or key, as tasks list shows it")
    .option("--for <span>", "how long the claim lasts: 30m, 2h (default 30m)", durationOf("--for"))
    .action(async function (this: Command, id: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "tasks.claim")
      const { for: forMs = CLAIM_LEASE_MS } = this.opts<{ for?: number }>()
      const claimed = await context.withServices((services) => services.tasks.claim(id, holderOf(this), forMs))
      renderAnswer(this, context, itemOf(snakeKeys(claimed)), () => `${card(claimed)}\n`)
    })

  annotate(tasks.command("release"), { effects: LOCAL_WRITE })
    .description("give back a task you claimed, before the claim lapses")
    .argument("<task>", "the task's id or key, as tasks list shows it")
    .action(async function (this: Command, id: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "tasks.release")
      const released = await context.withServices((services) => services.tasks.release(id, holderOf(this)))
      renderAnswer(this, context, itemOf(snakeKeys(released)), () => `${card(released)}\n`)
    })

  annotate(tasks.command("close"), { effects: LOCAL_WRITE })
    .description("close a task: done, or dismissed when it needs no answer; a closed task stays closed")
    .argument("<task>", "the task's id, as tasks list shows it")
    .requiredOption("--as <state>", "how it is closed: done, or dismissed — it needs no answer", closedStateOf)
    .option("--reason <text>", "why, kept with the task — no-reply-needed, for example")
    .action(async function (this: Command, id: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "tasks.close")
      const { as, reason } = this.opts<{ as: "done" | "dismissed"; reason?: string }>()
      const closed = await context.withServices((services) =>
        services.tasks.close(id, { as, by: "owner", ...(reason === undefined ? {} : { reason }) }),
      )
      renderAnswer(this, context, itemOf(snakeKeys(closed)), () => `${line(closed)}\n`)
    })

  return tasks
}

export const tasksStatsCommand = (messenger: Messenger): Command => {
  return annotate(new Command("show"), { effects: LOCAL_READ, output: { entity: "task_stats" } })
    .description("per chat: how many tasks are open, the oldest open one, the median time to close")
    .option("--chat <chat>", `only this chat; ${messenger.chatArgument}`)
    .option("--type <name>", "only this type: question, request, mention or promise", taskTypeOf)
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const { chat, type } = this.opts<{ chat?: string; type?: TaskView["kind"] }>()
      refuseJsonl(context.format)
      const { rows, account } = await context.withServices(async (services) => ({
        rows: await services.tasks.stats({
          ...(chat === undefined ? {} : { chat }),
          ...(type === undefined ? {} : { type }),
        }),
        account: await services.messages.reader(),
      }))
      if (rows.length === 0) context.renderer.note("no tasks yet")
      renderAnswer(this, context, taskStatsAnswer(rows, account), () =>
        rows.length === 0
          ? ""
          : `${rows
              .map(({ group, open, oldestOpenAt, medianCloseMs }) =>
                [
                  group,
                  `${open} open`,
                  oldestOpenAt ? `oldest ${oldestOpenAt.toISOString().slice(0, 16).replace("T", " ")}` : "",
                  medianCloseMs === undefined ? "" : `median ${Math.round(medianCloseMs / 60_000)} min to close`,
                ]
                  .filter(Boolean)
                  .join("  "),
              )
              .join("\n")}\n`,
      )
    })
}
