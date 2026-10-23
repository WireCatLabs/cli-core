import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command, Option } from "commander"
import { TAGGING_QUERY, type TaggingItem, type TagTargetInput, type TagTargetView } from "../../services/tags.js"
import { changesStore, FETCH, LOCAL_READ, LOCAL_WRITE } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { listQuery, pagedList, pageOf, typedQuery, withQuery } from "../list-query.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"

const targetOptions = (command: Command, messenger: Messenger, verb: string): Command =>
  command
    .argument("<tag...>", "one or more tags: 1–32 letters a–z, digits and hyphens; upper case is lowered")
    .option("--chat <chat>", `the chat to ${verb}, or the chat of --message; ${messenger.chatArgument}`)
    .option("--contact <person>", `the person to ${verb}: their id, @username or name, as the local store knows them`)
    .option("--message <message>", `the message to ${verb}: its id in --chat, or a msg: locator alone`)
    .option("--task <id>", `the task to ${verb}: its id or key, as tasks list shows it`)

const describe = ({ type, chatId, personId, messageId, taskId }: TagTargetView) =>
  type === "chat"
    ? `chat ${chatId}`
    : type === "contact"
      ? `person ${personId}`
      : type === "task"
        ? `task ${taskId}`
        : `message ${messageId} in chat ${chatId}`

const line = (one: TaggingItem) => `${one.tag}  ${one.type}  ${one.name ?? ""} (${one.target})`

const sourceOf = (value: string): "manual" | "auto" => {
  if (value !== "manual" && value !== "auto") throw new CliError("validation_error", "--claim takes manual or auto")
  return value
}

/** The owner's labels, in the local store only: `tag:` in a search finds what they label. */
export const tagsCommand = (messenger: Messenger): Command => {
  const tool = `${messenger.app.command} personal`
  const tags = new Command("tags")
    .summary("tags on stored messages and other records")
    .description(
      "your own labels on chats, people, messages and tasks, kept in the local store and never sent; tag: in a search finds them",
    )

  changesStore(
    annotate(tags.command("rebuild"), {
      output: { entity: "automatic_tags" },
      effects: FETCH,
      examples: [`${tool} tags rebuild --chat "Book club" --dry-run`],
    }),
  )
    .description("derive local group/channel tags from cached metadata using keyword rules")
    .option(
      "--chat <chat>",
      "a stored group/channel; repeat to select several",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--limit <n>", "process at most 1–500 chats", positiveCount("--limit"), 50)
    .option("--sync-first", "read current descriptions from the messenger before classifying")
    .option("--dry-run", "preview cached classification without changing the store")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const { chat, limit, syncFirst, dryRun } = this.opts<{
        chat: string[]
        limit: number
        syncFirst?: boolean
        dryRun?: boolean
      }>()
      if (!dryRun) refuseLocalWrite(context, messenger.app.command, "tags.rebuild")
      const done = await context.withServices((services) =>
        services.metadata.auto({ chats: chat, limit: Number(limit), refresh: syncFirst, dryRun }),
      )
      renderAnswer(this, context, itemOf(snakeKeys(done)))
    })

  targetOptions(
    annotate(tags.command("add"), {
      output: { entity: "tag_change" },
      effects: LOCAL_WRITE,
      examples: [`${tool} tags add reading --chat "Book club"`],
    }).description("put tags on one chat, person, message or task"),
    messenger,
    "tag",
  ).action(async function (this: Command, given: string[]) {
    const context = messengerContext(this, messenger)
    refuseLocalWrite(context, messenger.app.command, "tags.add")
    const target = this.opts<TagTargetInput>()
    const done = await context.withServices((services) => services.tags.add(target, given))
    renderAnswer(this, context, itemOf(snakeKeys(done)), () =>
      done.added.length ? `${describe(done.target)}: ${done.added.join(", ")}\n` : "",
    )
    if (done.unchanged.length && context.format === "pretty")
      context.renderer.note(`already there: ${done.unchanged.join(", ")}`)
  })

  targetOptions(
    annotate(tags.command("remove"), {
      output: { entity: "tag_change" },
      effects: LOCAL_WRITE,
      examples: [`${tool} tags remove reading --chat "Book club"`],
    }).description("take tags off one chat, person, message or task"),
    messenger,
    "untag",
  )
    .addOption(new Option("--claim <claim>", "remove only this ownership claim: manual or auto").argParser(sourceOf))

    .action(async function (this: Command, given: string[]) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "tags.remove")
      const target = this.opts<TagTargetInput>()
      const done = await context.withServices((services) =>
        services.tags.remove(
          target,
          given,
          this.opts<{ claim?: "manual" | "auto" }>().claim ?? this.opts<{ source?: "manual" | "auto" }>().source,
        ),
      )
      renderAnswer(this, context, itemOf(snakeKeys(done)), () =>
        done.removed.length ? `${describe(done.target)}: ${done.removed.join(", ")} removed\n` : "",
      )
      if (done.unchanged.length && context.format === "pretty")
        context.renderer.note(`not there: ${done.unchanged.join(", ")}`)
    })

  withQuery(
    annotate(tags.command("list"), {
      effects: LOCAL_READ,
      examples: [`${tool} tags list`, `${tool} tags list tag:reading`],
    })
      .summary("tagged chats, people, messages and tasks")
      .description("what is tagged: this account's chats, messages and tasks, and the people of its messenger"),
    TAGGING_QUERY,
  ).action(async function (this: Command, words: string[]) {
    const context = messengerContext(this, messenger)
    const query = listQuery(typedQuery(words), TAGGING_QUERY, "tags list")
    const found = await context.withServices((services) =>
      services.tags.list({ ...(query ? { query } : {}), ...pageOf(context.settings) }),
    )
    renderAnswer(this, context, pagedList("tags list", context.settings, found), () =>
      found.items.length === 0 ? "" : `${found.items.map(line).join("\n")}\n`,
    )
    if (found.items.length === 0 && context.format === "pretty")
      context.renderer.note("nothing is tagged — `tags add <tag> --chat <chat>` tags a chat")
  })

  return tags
}
