import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { AGENDA_QUERY, type Agenda, agendaItem } from "../../services/agenda.js"
import { aheadOf, momentOf } from "../../services/moment.js"
import {
  CLAIM_LEASE_MS,
  closedStateOf,
  type PairDecision,
  TASK_PAIR_QUERY,
  TASK_QUERY,
  type TaskCard,
  type TaskLinkOptionKind,
  type TaskPlan,
  type TaskView,
  taskLinkKindOf,
  taskTypeOf,
} from "../../services/tasks.js"
import type { TaskPair } from "../../store/index.js"
import { holderOf as holderIn } from "../author.js"
import { environmentOf } from "../context.js"
import { LOCAL_READ, LOCAL_WRITE } from "../effects.js"
import { itemOf, listOf, renderAnswer, snakeKeys } from "../envelope.js"
import { listQuery, pagedList, pageOf, queryTerms, typedQuery, withQuery } from "../list-query.js"
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

const toReview = (count: number | undefined) =>
  count ? `; ${count} possible duplicate pair(s) went to tasks duplicates` : ""

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
      (task) =>
        `  ${task.key}  ${task.reasons.join(",").padEnd(9)}  due ${when(task.dueAt)}  ${task.title}` +
        (task.claimedBy === null ? "" : `  (claimed by ${task.claimedBy} until ${when(task.claimedUntil)})`),
    ),
    `owed — they wrote last (${agenda.owed.length})`,
    ...agenda.owed.map(chat),
    `waiting — you wrote last (${agenda.waiting.length})`,
    ...agenda.waiting.map(chat),
    `unsynced — moved, newest message not stored: read before judging (${agenda.unsynced.length})`,
    ...agenda.unsynced.map(chat),
  ].join("\n")
}

const pairLine = (pair: TaskPair) =>
  [
    pair.task?.key ?? pair.source ?? "?",
    "→",
    pair.other.key,
    String(pair.score).padStart(3),
    pair.band.padEnd(9),
    `${pair.task?.title ?? ""} | ${pair.other.title}`,
    `(${pair.reasons.join(", ")})`,
  ].join("  ")

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
    .option("--title <title>", `one line: the action and its object — ${verb}`)
    .option("--description <text>", "the detail, in Markdown: who owes whom, done when, next step, keywords")
    .option(
      "--due <time>",
      "when it must be done: an ISO 8601 time or 2h, 3d from now; none clears it",
      dateOrNone("--due"),
    )
    .option(
      "--remind-time <time>",
      "when to look at it again: an ISO 8601 time or 2h, 3d from now; none clears it",
      dateOrNone("--remind-time"),
    )

const categoryHelp = "what it is about, from the list tasks categories prints: money, documents, meeting, …"

const holderOf = (command: Command) =>
  holderIn(environmentOf(command).env ?? process.env, command.opts<{ holder?: string }>().holder)

const HOLDER_HELP =
  "who you are for claims: a session id or a chat id; default WIRECAT_HOLDER, else Claude Code's session, else the agent's name"

const planFrom = (options: {
  title?: string
  description?: string
  due?: Date | "none"
  remindTime?: Date | "none"
  category?: string
}) => {
  const plan: TaskPlan = {}
  if (options.category !== undefined) plan.category = options.category
  if (options.title !== undefined) plan.title = options.title
  if (options.description !== undefined) plan.description = options.description
  if (options.due !== undefined) plan.dueAt = options.due === "none" ? null : options.due
  if (options.remindTime !== undefined) plan.nextCheckAt = options.remindTime === "none" ? null : options.remindTime
  return plan
}

/** What waits on the owner — kept in the local store by `src/tasks/`; nothing here reaches the messenger. */
export const tasksCommand = (messenger: Messenger): Command => {
  const tool = messenger.app.command
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
      .requiredOption("--type <type>", "the task's type: question, request, mention or promise", taskTypeOf)
      .requiredOption("--category <name>", categoryHelp)
      .option(
        "--into <id>",
        "when tasks add listed tasks that may be the same job: link the message to this one instead of opening a task",
      )
      .option("--new", "when tasks add listed tasks that may be the same job: open the task anyway"),
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
      into?: string
      new?: boolean
    }>()
    const { into, new: anyway, ...rest } = options
    const plan = planFrom(rest)
    const {
      task,
      created,
      attached,
      review,
      card: planned,
    } = await context.withServices((services) =>
      services.tasks.add(message, options.type, "owner", plan, {
        ...(into === undefined ? {} : { attach: into }),
        ...(anyway ? { new: true } : {}),
      }),
    )
    renderAnswer(
      this,
      context,
      itemOf(
        snakeKeys({
          ...task,
          created,
          ...(attached ? { attached, review } : {}),
          ...(planned ? { card: planned } : {}),
        }),
      ),
      () => `${planned ? card(planned) : line(task)}\n`,
    )
    if (attached && context.format === "pretty")
      context.renderer.note(`the message is linked to ${task.key ?? task.id}; no task was opened${toReview(review)}`)
    else if (!created && context.format === "pretty")
      context.renderer.note("this source already has a task — that one is shown, unchanged")
  })

  planOptions(
    annotate(tasks.command("plan"), { effects: LOCAL_WRITE })
      .summary("set a task's title, description, due date, next check and category")
      .description("set a task's title, description, due date, next check and category; nothing reaches the messenger")
      .argument("<task>", "the task's id or key, as tasks list shows it")
      .option("--category <name>", `${categoryHelp}; a change is kept in the task's history`),
    "send Alex the API token",
  ).action(async function (this: Command, id: string) {
    const context = messengerContext(this, messenger)
    refuseLocalWrite(context, messenger.app.command, "tasks.plan")
    const plan = planFrom(this.opts())
    if (Object.keys(plan).length === 0)
      throw new CliError(
        "validation_error",
        "give at least one of --title, --description, --due, --remind-time, --category",
      )
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
      if (!("relations" in linked) && linked.review && context.format === "pretty")
        context.renderer.note(`${linked.review} possible duplicate pair(s) went to tasks duplicates`)
    })

  annotate(tasks.command("show"), { effects: LOCAL_READ })
    .description("one task: its plan and everything linked to it")
    .argument("<task>", "the task's id or key, as tasks list shows it")
    .action(async function (this: Command, id: string) {
      const context = messengerContext(this, messenger)
      const shown = await context.withServices((services) => services.tasks.show(id))
      renderAnswer(this, context, itemOf(snakeKeys(shown)), () => `${card(shown)}\n`)
    })

  annotate(tasks.command("related"), { effects: LOCAL_READ, examples: [`${tool} tasks related PR-12`] })
    .summary("tasks that may be the same job as this one, best first; merges nothing")
    .description(
      "tasks that may be the same job as this one, best first, each with a band — likely, maybe, different — and the " +
        "reasons; merges nothing",
    )
    .argument("<task>", "the task's id or key, as tasks list shows it")
    .option("--limit <n>", "how many, at most 40 (default 10)", positiveCount("--limit"))
    .action(async function (this: Command, id: string) {
      const context = messengerContext(this, messenger)
      const { limit = 10 } = this.opts<{ limit?: number }>()
      const found = await context.withServices((services) => services.tasks.similar(id, { limit }))
      renderAnswer(
        this,
        context,
        listOf("tasks related", { items: found.map(snakeKeys), limit, has_more: false }),
        () =>
          found.length === 0
            ? ""
            : `${found
                .map((one) =>
                  [
                    one.key,
                    String(one.score).padStart(3),
                    one.band.padEnd(9),
                    one.title,
                    `(${one.reasons.join(", ")})`,
                  ].join("  "),
                )
                .join("\n")}\n`,
      )
      if (found.length === 0 && context.format === "pretty") context.renderer.note("no open or recent task looks alike")
    })

  const duplicates = withQuery(
    annotate(tasks.command("duplicates"), { effects: LOCAL_READ })
      .summary("pairs of tasks a rule opened that may be one job, newest first")
      .description(
        "pairs of tasks a rule opened that may be one job, newest first, with score and reasons: merge, reject or " +
          "defer each; decision:unsure lists the ones deferred to the owner",
      ),
    TASK_PAIR_QUERY,
  )
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .action(async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger)
      const { limit, offset } = pageOf(context.settings)
      const decision = queryTerms(words, TASK_PAIR_QUERY, "tasks duplicates").get("decision") as PairDecision
      const rows = await context.withServices((services) =>
        services.tasks.duplicates({ decision, limit: limit + 1, offset }),
      )
      const shown = rows.slice(0, limit)
      renderAnswer(
        this,
        context,
        pagedList("tasks duplicates", context.settings, {
          items: shown.map(snakeKeys),
          has_more: rows.length > limit,
        }),
        () => (shown.length === 0 ? "" : `${shown.map(pairLine).join("\n")}\n`),
      )
      if (shown.length === 0 && context.format === "pretty")
        context.renderer.note(decision === "unsure" ? "no pair waits for the owner" : "no pair waits for review")
    })

  const decided = (decision: "rejected" | "unsure", permission: "tasks.duplicates.reject" | "tasks.duplicates.defer") =>
    async function (this: Command, dup: string, task: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, permission)
      const pair = await context.withServices((services) =>
        services.tasks.decideDuplicate(dup, task, decision, "owner"),
      )
      renderAnswer(this, context, itemOf(snakeKeys(pair)), () => `${pair.decision}  ${pairLine(pair)}\n`)
    }

  annotate(duplicates.command("reject"), {
    effects: LOCAL_WRITE,
    examples: [`${tool} tasks duplicates reject PR-14 PR-12`],
  })
    .summary("two tasks are not the same job: the pair is never offered again")
    .description("two tasks are not the same job: the pair leaves the list and is never offered again")
    .argument("<dup>", "the task listed as the duplicate, by its id or key")
    .argument("<task>", "the task it was paired with")
    .action(decided("rejected", "tasks.duplicates.reject"))

  annotate(duplicates.command("defer"), {
    effects: LOCAL_WRITE,
    examples: [`${tool} tasks duplicates defer PR-14 PR-12`],
  })
    .summary("the fields and the text cannot tell: leave the pair to the owner")
    .description("the fields and the text cannot tell: leave the pair to the owner, who lists it with decision:unsure")
    .argument("<dup>", "the task listed as the duplicate, by its id or key")
    .argument("<task>", "the task it was paired with")
    .action(decided("unsure", "tasks.duplicates.defer"))

  annotate(tasks.command("merge"), { effects: LOCAL_WRITE, examples: [`${tool} tasks merge PR-14 --into PR-12`] })
    .summary("one job seen twice: fold the duplicate into the task that stays")
    .description(
      "one job seen twice: link every message of the duplicate to the task and close the duplicate dismissed, " +
        "duplicate-of the task; nothing is deleted, and tasks unmerge undoes it",
    )
    .argument("<dup>", "the duplicate, by its id or key; it must be open")
    .requiredOption("--into <id>", "the task that stays, by its id or key")
    .action(async function (this: Command, dup: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "tasks.merge")
      const { into } = this.opts<{ into: string }>()
      const merged = await context.withServices((services) => services.tasks.merge(dup, into, "owner"))
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(merged)),
        () =>
          `${dup} merged into ${merged.task.key}; ${merged.linked} message(s) linked${toReview(merged.review)}\n` +
          `${card(merged.task)}\n`,
      )
    })

  annotate(tasks.command("unmerge"), { effects: LOCAL_WRITE, examples: [`${tool} tasks unmerge PR-14`] })
    .summary("undo a merge: reopen the task and remove its duplicate-of relation")
    .description(
      "undo a merge: reopen the task and remove its duplicate-of relation; messages the merge linked stay linked",
    )
    .argument("<dup>", "the merged task, by its id or key")
    .action(async function (this: Command, dup: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "tasks.unmerge")
      const unmerged = await context.withServices((services) => services.tasks.unmerge(dup, "owner"))
      renderAnswer(this, context, itemOf(snakeKeys(unmerged)), () => `${card(unmerged.task)}\n`)
    })

  withQuery(
    annotate(tasks.command("agenda"), { effects: LOCAL_READ })
      .summary("what needs a look today: tasks due, chats you owe an answer, chats you wait on")
      .description(
        "what needs a look today, from the local store and without message text: tasks overdue, due or to check, " +
          "chats where you owe an answer, chats where you wait for one",
      ),
    AGENDA_QUERY,
  )
    .option(
      "--due-within <duration>",
      "list tasks due within this: 30m, 2h, 1d (default 1d)",
      durationOf("--due-within"),
    )
    .option(
      "--unanswered <duration>",
      "list chats where someone else wrote last this long ago (default 1d)",
      durationOf("--unanswered"),
    )
    .option(
      "--waiting <duration>",
      "list chats where you wrote last this long ago (default 7d)",
      durationOf("--waiting"),
    )
    .option(
      "--within <duration>",
      "leave out chats silent longer than this: they ended (default 30d)",
      durationOf("--within"),
    )
    .option("--holder <name>", HOLDER_HELP)
    .action(async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger)
      const options = this.opts<{
        dueWithin?: number
        unanswered?: number
        waiting?: number
        within?: number
      }>()
      const query = listQuery(typedQuery(words), AGENDA_QUERY, "tasks agenda")
      const agenda = await context.withServices((services) =>
        services.agenda.show({
          ...(options.dueWithin === undefined ? {} : { dueWithin: options.dueWithin }),
          ...(options.unanswered === undefined ? {} : { unanswered: options.unanswered }),
          ...(options.waiting === undefined ? {} : { waiting: options.waiting }),
          ...(options.within === undefined ? {} : { within: options.within }),
          ...(query ? { query } : {}),
          holder: holderOf(this),
        }),
      )
      renderAnswer(this, context, itemOf(agendaItem(agenda)), () => `${agendaText(agenda)}\n`)
    })

  annotate(tasks.command("categories"), { effects: LOCAL_READ, examples: [`${tool} tasks categories`] })
    .summary("the categories a task takes, with what each means")
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

  annotate(tasks.command("claim"), { effects: LOCAL_WRITE, examples: [`${tool} tasks claim PR-12 --lease 2h`] })
    .description("take an open task so no other agent works it at once; the claim lapses by itself")
    .argument("<task>", "the task's id or key, as tasks list shows it")
    .option(
      "--lease <duration>",
      "how long the claim lasts: 30m, 2h (default 30m); claiming again extends it",
      durationOf("--lease"),
    )
    .option("--holder <name>", HOLDER_HELP)
    .action(async function (this: Command, id: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "tasks.claim")
      const { lease = CLAIM_LEASE_MS } = this.opts<{ lease?: number }>()
      const claimed = await context.withServices((services) => services.tasks.claim(id, holderOf(this), lease))
      renderAnswer(this, context, itemOf(snakeKeys(claimed)), () => `${card(claimed)}\n`)
    })

  annotate(tasks.command("release"), { effects: LOCAL_WRITE, examples: [`${tool} tasks release PR-12`] })
    .description("give back a task you claimed, before the claim lapses; the owner may release any")
    .argument("<task>", "the task's id or key, as tasks list shows it")
    .option("--holder <name>", HOLDER_HELP)
    .action(async function (this: Command, id: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "tasks.release")
      const released = await context.withServices((services) => services.tasks.release(id, holderOf(this)))
      renderAnswer(this, context, itemOf(snakeKeys(released)), () => `${card(released)}\n`)
    })

  annotate(tasks.command("close"), { effects: LOCAL_WRITE })
    .description(
      "close a task: done, or dismissed when it needs no answer; a closed task stays closed, unless tasks unmerge reopens a merged one",
    )
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
    .option("--type <type>", "only this type: question, request, mention or promise", taskTypeOf)
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
