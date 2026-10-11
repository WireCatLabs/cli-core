import { Command } from "commander"
import { momentOf } from "../../services/moment.js"
import { closedStateOf, type TaskView, taskStateOf, taskTypeOf, taskTypesOf } from "../../services/tasks.js"
import { listed, positiveCount } from "../paging.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"

const line = ({ id, state, kind, group, createdAt, message, note }: TaskView) =>
  [
    id.slice(0, 8),
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

/** What waits on the owner — kept in the local store by `src/tasks/`; nothing here reaches the messenger. */
export const tasksCommand = (messenger: Messenger): Command => {
  const tasks = new Command("tasks").description(
    "what waits on you — unanswered questions, mentions, requests, promises — kept in the local store; review and serve add them",
  )

  tasks
    .command("list")
    .description("tasks, oldest first, with their message or note source")
    .option("--state <state>", "only tasks in this state: open, done or dismissed", taskStateOf)
    .option("--chat <chat>", `only this chat's tasks; ${messenger.chatArgument}`)
    .option("--type <names>", "only these types, comma-separated: question, request, mention, promise", taskTypesOf)
    .option("--before-time <time>", "only tasks opened before this ISO 8601 time, or 2h / 1d ago")
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const options = this.opts<{
        state?: TaskView["state"]
        chat?: string
        type?: TaskView["kind"][]
        beforeTime?: string
        limit?: number
      }>()
      const found = await context.withServices((services) =>
        services.tasks.list({
          ...(options.state === undefined ? {} : { state: options.state }),
          ...(options.chat === undefined ? {} : { chat: options.chat }),
          ...(options.type === undefined ? {} : { types: options.type }),
          ...(options.beforeTime === undefined ? {} : { before: momentOf(options.beforeTime, "--before-time") }),
          ...(options.limit === undefined ? {} : { limit: options.limit }),
        }),
      )
      if (context.format === "jsonl") context.renderer.stream(found)
      else if (context.format !== "pretty") context.renderer.result(listed(found))
      else if (found.length === 0) context.renderer.note("no tasks — review and serve add them as questions arrive")
      else context.streams.data(`${found.map(line).join("\n")}\n`)
    })

  tasks
    .command("add")
    .description("add a task for a stored message or note — a promise, a request")
    .argument("<message>", "a message locator, msg:<provider>/<account>/<chat>/<message>, or note:<id>")
    .requiredOption("--type <name>", "the task's type: question, request, mention or promise", taskTypeOf)
    .action(async function (this: Command, message: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "tasks.add")
      const { type } = this.opts<{ type: TaskView["kind"] }>()
      const { task, created } = await context.withServices((services) => services.tasks.add(message, type, "owner"))
      if (context.format !== "pretty") context.renderer.result({ ...task, created })
      else {
        context.streams.data(`${line(task)}\n`)
        if (!created) context.renderer.note("this source already has a task — that one is shown")
      }
    })

  tasks
    .command("close")
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
      if (context.format !== "pretty") context.renderer.result(closed)
      else context.streams.data(`${line(closed)}\n`)
    })

  return tasks
}

export const tasksStatsCommand = (messenger: Messenger): Command => {
  return new Command("show")
    .description("per chat: how many tasks are open, the oldest open one, the median time to close")
    .option("--chat <chat>", `only this chat; ${messenger.chatArgument}`)
    .option("--type <name>", "only this type: question, request, mention or promise", taskTypeOf)
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const { chat, type } = this.opts<{ chat?: string; type?: TaskView["kind"] }>()
      const rows = await context.withServices((services) =>
        services.tasks.stats({
          ...(chat === undefined ? {} : { chat }),
          ...(type === undefined ? {} : { type }),
        }),
      )
      if (context.format !== "pretty") context.renderer.result(listed(rows))
      else if (rows.length === 0) context.renderer.note("no tasks yet")
      else
        context.streams.data(
          `${rows
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
