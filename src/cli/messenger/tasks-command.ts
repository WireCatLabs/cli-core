import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { readOnlyLockOf, readOnlyRefusal } from "../../ports/app.js"
import { AGENDA_QUERY, type Agenda, agendaItem } from "../../services/agenda.js"
import { storedChatId } from "../../services/message-resolution.js"
import { aheadOf, momentOf } from "../../services/moment.js"
import { unlistedNote } from "../../services/task-categories.js"
import { ARRIVAL_WINDOW, applyTaskRulesToChats, type ChatRulePass } from "../../services/task-rules.js"
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
import type { CloseSuggestion, TaskPair } from "../../store/index.js"
import { PRIORITY_LABELS, priorityOf } from "../../tasks/index.js"
import { actorOf, holderOf as holderIn } from "../author.js"
import { environmentOf } from "../context.js"
import { destroysNothing, LOCAL_READ, LOCAL_WRITE, ownerOnlyOption } from "../effects.js"
import { itemOf, listOf, renderAnswer, snakeKeys } from "../envelope.js"
import { listQuery, pagedList, pageOf, queryTerms, typedQuery, withQuery } from "../list-query.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"
import { coverageGaps } from "./search-answers.js"
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
  count ? `; ${count} possible duplicate pair(s) went to tasks duplicates list` : ""

const suggestionLine = ({ as, by, certainty, reason }: CloseSuggestion) =>
  `close suggested: ${as} by ${by} at certainty ${certainty}${reason === null ? "" : ` — ${reason}`}; waits on the owner`

const card = (task: TaskCard) =>
  [
    `${task.key}  ${task.status}  ${task.type}  ${task.category ?? "—"}  ${task.title}`,
    `due ${when(task.dueAt)}  next check ${when(task.nextCheckAt)}  source ${task.source ?? "—"}`,
    ...(task.priorityLabel === null ? [] : [`priority ${task.priorityLabel}`]),
    ...(task.agent === null ? [] : [`agent ${task.agent}`]),
    ...(task.claimedBy === null ? [] : [`claimed by ${task.claimedBy} until ${when(task.claimedUntil)}`]),
    ...task.assignments.filter((one) => one.role === "assignee").map((one) => `assignee ${one.to}`),
    ...(task.closeSuggestion === null ? [] : [suggestionLine(task.closeSuggestion)]),
    ...(task.closeCertainty === null ? [] : [`closed by an agent at certainty ${task.closeCertainty}`]),
    ...(task.description ? ["", task.description, ""] : []),
    ...task.links.map((link) => `${link.kind.padEnd(12)} ${link.to ?? link.targetText ?? "?"}`),
    ...task.linkedFrom.map((link) => `${link.from} ${link.kind} this task`),
  ].join("\n")

const applyText = (pass: ChatRulePass, yes: boolean, tool: string) =>
  yes
    ? `${pass.chat}: ${pass.messages} messages read; ${pass.added} opened, ${pass.closed} closed` +
      (pass.review ? `; ${pass.review} may be the same job as another — ${tool} tasks duplicates list` : "")
    : [
        `${pass.chat}: ${pass.messages} messages read; would open ${pass.tasks.length}, close ${pass.closed}`,
        ...pass.tasks.map((task) => `  ${task.kind.padEnd(8)} ${(task.category ?? "—").padEnd(13)} ${task.source}`),
        ...(pass.tasks.length > 0 ? [`  ${tool} tasks scan ${pass.chat} --yes opens them`] : []),
      ].join("\n")

const agendaChats = (agenda: Agenda) => [...agenda.unsynced, ...agenda.owed, ...agenda.waiting]

const agendaGaps = (agenda: Agenda) =>
  coverageGaps(
    agendaChats(agenda).map(({ coverage }) => coverage),
    0,
    agenda.since,
  )

const STATE_MARK = { complete: "", partial: "  [partial]", unknown: "  [never fetched]" } as const

const agendaText = (agenda: Agenda) => {
  const chat = (one: Agenda["owed"][number]) =>
    `  ${when(one.lastMessageAt)}  ${one.title ?? one.chatId}  ${one.lastMessage ?? one.chatId}` +
    (one.openTasks.length > 0 ? `  (${one.openTasks.length} open)` : "") +
    STATE_MARK[one.coverage.completeness.state]
  const [history] = agendaGaps(agenda).missing
  return [
    ...(history ? [`${history.why}: sync before trusting what is listed`] : []),
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
    `assigned — others owe you, oldest first (${agenda.assigned.length})`,
    ...agenda.assigned.map(
      (task) => `  ${task.key}  ${task.assignees.join(",")}  since ${when(task.createdAt)}  ${task.title}`,
    ),
    ...agenda.unlistedCategories.map(
      ({ name, openTasks }) =>
        `${openTasks} open task${openTasks === 1 ? "" : "s"} use ${name}, which is not in the task categories: ` +
        `tasks list category:${name} shows them`,
    ),
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
    .option(
      "--assignee <person...>",
      "who does it: sender (whoever sent the task's message) or person:<id>; none clears it. Leave it out when " +
        "unsure: a task with no assignee is better than none",
    )

const certaintyArgument = (typed: string) => {
  const value = Number(typed.trim())
  if (typed.trim() === "" || !Number.isFinite(value) || value < 0 || value > 1)
    throw new CliError("validation_error", `--certainty takes a number from 0 to 1 — not "${typed}"`)
  return value
}

const categoryHelp = "what it is about, from the list tasks categories prints: money, documents, meeting, …"

const holderOf = (command: Command) =>
  holderIn(environmentOf(command).env ?? process.env, command.opts<{ holder?: string }>().holder)

const HOLDER_HELP =
  "who you are for claims: a session id or a chat id; default WIRECAT_HOLDER, else Claude Code's session, else the agent's name"

const planFrom = (options: {
  priority?: number | null
  parent?: string
  title?: string
  description?: string
  due?: Date | "none"
  remindTime?: Date | "none"
  category?: string
  assignee?: string[]
}) => {
  const plan: TaskPlan = {}
  if (options.priority !== undefined) plan.priority = options.priority
  if (options.parent !== undefined) plan.parent = options.parent === "none" ? null : options.parent
  if (options.category !== undefined) plan.category = options.category
  if (options.title !== undefined) plan.title = options.title
  if (options.description !== undefined) plan.description = options.description
  if (options.due !== undefined) plan.dueAt = options.due === "none" ? null : options.due
  if (options.remindTime !== undefined) plan.nextCheckAt = options.remindTime === "none" ? null : options.remindTime
  if (options.assignee !== undefined)
    plan.assignees = options.assignee.length === 1 && options.assignee[0] === "none" ? null : options.assignee
  return plan
}

/** What waits on the owner — kept in the local store by `src/tasks/`; nothing here reaches the messenger. */
export const tasksCommand = (messenger: Messenger): Command => {
  const tool = messenger.app.command
  /** Under the read-only lock an unattended agent writes, so the task's history and pair decisions name it, not the owner. */
  const writerOf = (command: Command): "agent" | "owner" =>
    readOnlyLockOf(messenger.app, environmentOf(command).env ?? process.env) || environmentOf(command).agent
      ? "agent"
      : "owner"
  const tasks = new Command("tasks")
    .summary("tasks found or kept in the local archive")
    .description(
      "what waits on you — unanswered questions, mentions, requests, promises — kept in the local store; review and serve add them",
    )

  withQuery(
    annotate(tasks.command("list"), {
      effects: LOCAL_READ,
      examples: [`${tool} personal tasks list --limit 10`],
    }).description("tasks, oldest first, with their message or note source"),
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
        context.renderer.note("no tasks — review, inbox and messages sync add them as questions arrive")
    })

  planOptions(
    destroysNothing(
      annotate(tasks.command("add"), {
        output: { entity: "task_created" },
        effects: LOCAL_WRITE,
        examples: [`${tool} personal tasks add note:101 --type promise --category documents --title "Review draft"`],
      }),
    )
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
      assignee?: string[]
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
      followUpOf,
      card: planned,
    } = await context.withServices((services) =>
      services.tasks.add(message, options.type, writerOf(this), plan, {
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
          ...(followUpOf ? { followUpOf } : {}),
          ...(planned ? { card: planned } : {}),
        }),
      ),
      () => `${planned ? card(planned) : line(task)}\n`,
    )
    if (attached && context.format === "pretty")
      context.renderer.note(`the message is linked to ${task.key ?? task.id}; no task was opened${toReview(review)}`)
    else if (!created && context.format === "pretty")
      context.renderer.note("this source already has a task — that one is shown, unchanged")
    else if (followUpOf && context.format === "pretty")
      context.renderer.note(
        `${task.key ?? task.id} follows up ${followUpOf.key} (${followUpOf.status}), which stays closed: linked follow-up-of`,
      )
  })

  planOptions(
    destroysNothing(
      annotate(tasks.command("update"), {
        output: { entity: "task_card" },

        effects: LOCAL_WRITE,
        examples: [`${tool} personal tasks update DOC-12 --title "Review draft"`],
      }),
    )
      .summary("update a task's text, schedule, category, assignees, priority or parent")
      .description(
        "update a task's text, schedule, category, assignees, priority or parent; nothing reaches the messenger",
      )
      .argument("<task>", "the task's id or key, as tasks list shows it")
      .option("--category <name>", `${categoryHelp}; a change is kept in the task's history`)
      .option(
        "--priority <n>",
        `${PRIORITY_LABELS.join(", ")} or none; 0 (urgent) … 4 (low) still read as before`,
        priorityOf,
      )
      .option("--parent <id>", "parent task in the same project; none clears it"),
    "send Alex the API token",
  ).action(async function (this: Command, id: string) {
    const context = messengerContext(this, messenger)
    refuseLocalWrite(context, messenger.app.command, "tasks.update")
    const plan = planFrom(this.opts())
    if (Object.keys(plan).length === 0)
      throw new CliError(
        "validation_error",
        "give at least one of --title, --description, --due, --remind-time, --category, --priority, --parent",
      )
    const planned = await context.withServices((services) => services.tasks.plan(id, plan, writerOf(this)))
    renderAnswer(this, context, itemOf(snakeKeys(planned)), () => `${card(planned)}\n`)
  })

  destroysNothing(
    annotate(tasks.command("link"), {
      output: { entity: "task_links" },
      effects: LOCAL_WRITE,
      examples: [`${tool} personal tasks link DOC-12 https://example.com/draft`],
    }),
  )
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
        services.tasks.link(id, { references: targets, chats: chat }, { kind, by: writerOf(this) }),
      )
      renderAnswer(this, context, itemOf(snakeKeys(linked)), () =>
        "relations" in linked
          ? `${linked.relations.map((one) => `${one.from} ${one.kind} ${one.to}`).join("\n")}\n`
          : `${card(linked)}\n`,
      )
      if (!("relations" in linked) && linked.review && context.format === "pretty")
        context.renderer.note(`${linked.review} possible duplicate pair(s) went to tasks duplicates list`)
    })

  annotate(tasks.command("show"), {
    output: { entity: "task_card" },
    effects: LOCAL_READ,
    examples: [`${tool} personal tasks show DOC-12`],
  })
    .description("one task: its plan and everything linked to it")
    .argument("<task>", "the task's id or key, as tasks list shows it")
    .action(async function (this: Command, id: string) {
      const context = messengerContext(this, messenger)
      const shown = await context.withServices((services) => services.tasks.show(id))
      renderAnswer(this, context, itemOf(snakeKeys(shown)), () => `${card(shown)}\n`)
    })

  annotate(tasks.command("related"), {
    output: { entity: "task_similar" },
    effects: LOCAL_READ,
    examples: [`${tool} tasks related PR-12`],
  })
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

  const duplicates = tasks.command("duplicates").description("pairs of tasks that may be one job")
  withQuery(
    annotate(duplicates.command("list"), {
      effects: LOCAL_READ,
      examples: [`${tool} tasks duplicates list --limit 10`, `${tool} tasks duplicates list decision:unsure`],
    })
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
      const decision = queryTerms(words, TASK_PAIR_QUERY, "tasks duplicates list").get("decision") as PairDecision
      const rows = await context.withServices((services) =>
        services.tasks.duplicates({ decision, limit: limit + 1, offset }),
      )
      const shown = rows.slice(0, limit)
      renderAnswer(
        this,
        context,
        pagedList("tasks duplicates list", context.settings, {
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
        services.tasks.decideDuplicate(dup, task, decision, writerOf(this)),
      )
      renderAnswer(this, context, itemOf(snakeKeys(pair)), () => `${pair.decision}  ${pairLine(pair)}\n`)
    }

  destroysNothing(
    annotate(duplicates.command("reject"), {
      output: { entity: "task_pair" },
      effects: LOCAL_WRITE,
      examples: [`${tool} tasks duplicates reject PR-14 PR-12`],
    }),
  )
    .summary("two tasks are not the same job: the pair is never offered again")
    .description("two tasks are not the same job: the pair leaves the list and is never offered again")
    .argument("<task>", "the task listed as the duplicate, by its id or key")
    .argument("<other-task>", "the task it was paired with")
    .action(decided("rejected", "tasks.duplicates.reject"))

  destroysNothing(
    annotate(duplicates.command("defer"), {
      output: { entity: "task_pair" },
      effects: LOCAL_WRITE,
      examples: [`${tool} tasks duplicates defer PR-14 PR-12`],
    }),
  )
    .summary("the fields and the text cannot tell: leave the pair to the owner")
    .description("the fields and the text cannot tell: leave the pair to the owner, who lists it with decision:unsure")
    .argument("<task>", "the task listed as the duplicate, by its id or key")
    .argument("<other-task>", "the task it was paired with")
    .action(decided("unsure", "tasks.duplicates.defer"))

  destroysNothing(
    annotate(tasks.command("merge"), {
      output: { entity: "task_merge" },
      effects: LOCAL_WRITE,
      examples: [`${tool} tasks merge PR-14 --into PR-12`],
    }),
  )
    .summary("one job seen twice: fold the duplicate into the task that stays")
    .description(
      "one job seen twice: link every message of the duplicate to the task and close the duplicate dismissed, " +
        "duplicate-of the task; nothing is deleted, and tasks unmerge undoes it",
    )
    .argument("<task>", "the duplicate, by its id or key; it must be open")
    .requiredOption("--into <id>", "the task that stays, by its id or key")
    .action(async function (this: Command, dup: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "tasks.merge")
      const { into } = this.opts<{ into: string }>()
      const merged = await context.withServices((services) => services.tasks.merge(dup, into, writerOf(this)))
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(merged)),
        () =>
          `${dup} merged into ${merged.task.key}; ${merged.linked} message(s) linked${toReview(merged.review)}\n` +
          `${card(merged.task)}\n`,
      )
    })

  destroysNothing(
    annotate(tasks.command("unmerge"), {
      output: { entity: "task_unmerge" },
      effects: LOCAL_WRITE,
      examples: [`${tool} tasks unmerge PR-14`],
    }),
  )
    .summary("undo a merge: reopen the task and remove its duplicate-of relation")
    .description(
      "undo a merge: reopen the task and remove its duplicate-of relation; messages the merge linked stay linked",
    )
    .argument("<task>", "the merged task, by its id or key")
    .action(async function (this: Command, dup: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "tasks.unmerge")
      const unmerged = await context.withServices((services) => services.tasks.unmerge(dup, writerOf(this)))
      renderAnswer(this, context, itemOf(snakeKeys(unmerged)), () => `${card(unmerged.task)}\n`)
    })

  withQuery(
    annotate(tasks.command("agenda"), {
      effects: LOCAL_READ,
      partial: true,
      examples: [`${tool} personal tasks agenda`],
    })
      .summary("what needs a look today: tasks due, chats you owe or wait on, what you are owed")
      .description(
        "what needs a look today, from the local store and without message text: tasks overdue, due or to check, " +
          "chats where you owe an answer, chats where you wait for one, open tasks someone else does",
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
      const { next, missing } = agendaGaps(agenda)
      renderAnswer(
        this,
        context,
        itemOf(agendaItem(agenda), { next, missing, ...(missing.length > 0 ? { meta: { complete: false } } : {}) }),
        () => `${agendaText(agenda)}\n`,
      )
    })

  annotate(tasks.command("categories"), {
    output: { entity: "task_categories" },
    effects: LOCAL_READ,
    examples: [`${tool} tasks categories`],
  })
    .summary("the categories a task takes, with what each means")
    .description("the categories a task takes, with what each means and the words a rule picks it by")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const [list, unlisted, file] = await context.withServices(async (services) =>
        Promise.all([
          services.tasks.categories(),
          services.tasks.unlistedCategories(),
          services.tasks.categoriesFile(),
        ]),
      )
      const items = list.map(({ name, meaning, triggers }) => ({ name, meaning, triggers }))
      renderAnswer(this, context, itemOf({ categories: items, unlisted, file: file ?? null }), () =>
        [
          ...items.map(({ name, meaning }) => `${name.padEnd(13)} ${meaning}`),
          ...(unlisted.length > 0 ? ["", ...unlistedNote(unlisted, tool)] : []),
          ...(file
            ? ["", `edit the list in ${file} (task_categories), or with ${tool} config set task_categories.<name>`]
            : []),
          "",
        ].join("\n"),
      )
    })

  destroysNothing(
    annotate(tasks.command("scan"), {
      output: { entity: "task_scan" },
      effects: LOCAL_WRITE,
      examples: [`${tool} tasks scan <chat>`, `${tool} tasks scan <chat> --last 300 --yes`],
    }),
  )
    .summary("build tasks from a chat's stored history: unanswered questions and mentions")
    .description(
      "the task rules over a chat's newest stored messages: in a one-to-one chat a question you did not answer, in a " +
        "group only a question in reply to you and a mention of you, open a task, and your answer closes one; a " +
        "channel opens none — for a chat the first sync left alone (config task_first_pass_per_chat). " +
        "Lists what would open and changes nothing unless --yes; with --yes the duplicate check runs as on a sync. " +
        "Reads only the local store",
    )
    .argument("<chat...>", messenger.chatArgument)
    .option(
      "--last <n>",
      `read the newest n stored messages of each chat (default ${ARRIVAL_WINDOW}, at most 1000)`,
      positiveCount("--last"),
    )
    .action(async function (this: Command, chats: string[]) {
      const context = messengerContext(this, messenger)
      const { last, yes = false } = this.optsWithGlobals<{ last?: number; yes?: boolean }>()
      if (yes) refuseLocalWrite(context, messenger.app.command, "tasks.scan")
      const passes = await context.withStore(
        async (store, account) => {
          const ids = []
          for (const chat of chats) ids.push(await storedChatId(messenger, chat, store, account, { includeLeft: true }))
          return applyTaskRulesToChats(store, account, ids, { ...(last === undefined ? {} : { last }), yes })
        },
        { name: "tasks scan" },
      )
      renderAnswer(
        this,
        context,
        listOf("tasks scan", { items: passes.map(snakeKeys), limit: passes.length, has_more: false }),
        () => `${passes.map((pass) => applyText(pass, yes, tool)).join("\n")}\n`,
      )
    })

  destroysNothing(
    annotate(tasks.command("claim"), {
      output: { entity: "task_card" },
      effects: LOCAL_WRITE,
      examples: [`${tool} tasks claim PR-12 --lease 2h`],
    }),
  )
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

  destroysNothing(
    annotate(tasks.command("release"), {
      output: { entity: "task_card" },
      effects: LOCAL_WRITE,
      examples: [`${tool} tasks release PR-12`],
    }),
  )
    .description("give back a task you claimed, before the claim lapses; the owner may release any")
    .argument("<task>", "the task's id or key, as tasks list shows it")
    .option("--holder <name>", HOLDER_HELP)
    .action(async function (this: Command, id: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "tasks.release")
      const released = await context.withServices((services) => services.tasks.release(id, holderOf(this)))
      renderAnswer(this, context, itemOf(snakeKeys(released)), () => `${card(released)}\n`)
    })

  destroysNothing(
    annotate(tasks.command("close"), {
      output: { entity: "task_closed" },
      effects: LOCAL_WRITE,
      examples: [
        `${tool} tasks close Q-15 --as done --certainty 0.9 --reason answered-in-chat`,
        `${tool} tasks close Q-15`,
      ],
    }),
  )
    .summary("close a task: done, or dismissed when it needs no answer; an agent's unsure close waits on the owner")
    .summary("close a task as done or dismissed")
    .description(
      "close a task: done, or dismissed when it needs no answer. An agent (AI_AGENT or CLAUDECODE set) states its " +
        "--certainty; below config task_agent_close_min, or with task_agent_close off, the task stays open and the " +
        "close waits on the owner, who confirms it with tasks close or refuses it with tasks reject. A closed task " +
        "stays closed, unless tasks unmerge reopens a merged one",
    )
    .argument("<task>", "the task's id or key, as tasks list shows it")
    .option(
      "--as <state>",
      "how it is closed: done, or dismissed — it needs no answer; the owner may leave it out to confirm an agent's close",
      closedStateOf,
    )
    .option("--reason <text>", "why, kept with the task — no-reply-needed, for example")
    .option(
      "--certainty <n>",
      "an agent's: how sure it is, 0 to 1, that the task needs nothing more",
      certaintyArgument,
    )
    .addOption(
      ownerOnlyOption(
        "--as-owner",
        "close it as yours although an agent's terminal runs the tool (AI_AGENT or CLAUDECODE set)",
      ),
    )
    .action(async function (this: Command, id: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "tasks.close")
      const { as, reason, certainty, asOwner } = this.opts<{
        as?: "done" | "dismissed"
        reason?: string
        certainty?: number
        asOwner?: boolean
      }>()
      const env = environmentOf(this).env ?? process.env
      const lock = readOnlyLockOf(messenger.app, env)
      if (lock && asOwner) throw readOnlyRefusal(lock, "close a task as the owner")
      const author = actorOf(this, asOwner)
      const byAgent = author !== "owner" || lock !== undefined
      const closed = await context.withServices((services) =>
        services.tasks.close(id, {
          by: byAgent ? "agent" : "owner",
          ...(author === "owner" ? {} : { agent: author }),
          ...(lock ? { suggestOnly: true } : {}),
          ...(as === undefined ? {} : { as }),
          ...(reason === undefined ? {} : { reason }),
          ...(certainty === undefined ? {} : { certainty }),
        }),
      )
      renderAnswer(this, context, itemOf(snakeKeys(closed)), () => `${line(closed)}\n`)
      if (closed.state === "open" && closed.closeSuggestion && context.format === "pretty")
        context.renderer.note(
          `${closed.key ?? id} stays open: the close waits on the owner — ${tool} tasks close ${closed.key ?? id} ` +
            `confirms it, ${tool} tasks reject ${closed.key ?? id} refuses it`,
        )
    })

  annotate(tasks.command("reject"), {
    output: { entity: "task_card" },
    effects: LOCAL_WRITE,
    examples: [`${tool} tasks reject Q-15`],
  })
    .summary("refuse an agent's close of a task: it stays open and the suggestion goes")
    .description(
      "refuse the close an agent suggested: the task stays open and leaves close:suggested; the agent may close it again",
    )
    .argument("<task>", "the task's id or key, as tasks list shows it")
    .addOption(
      ownerOnlyOption(
        "--as-owner",
        "refuse it as yours although an agent's terminal runs the tool (AI_AGENT or CLAUDECODE set)",
      ),
    )
    .action(async function (this: Command, id: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "tasks.reject")
      const author = actorOf(this, this.opts<{ asOwner?: boolean }>().asOwner)
      const rejected = await context.withServices((services) =>
        services.tasks.reject(id, author === "owner" ? "owner" : "agent"),
      )
      renderAnswer(this, context, itemOf(snakeKeys(rejected)), () => `${card(rejected)}\n`)
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
