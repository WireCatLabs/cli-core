import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { renderPage, window, withPaging } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"
import { capability } from "./port.js"

const listed = (messenger: Messenger) =>
  async function (this: Command, chat: string) {
    const [, query] = this.args
    const context = messengerContext(this, messenger)
    if (context.settings.offline) {
      throw new CliError("validation_error", "`topics` asks the messenger; not with --offline")
    }
    const wanted = { ...window(context.settings), ...(query ? { search: query } : {}) }
    renderPage(
      context,
      await context.withMessenger((adapter) => capability(adapter, "topics", "list forum topics")(chat, wanted)),
    )
  }

/** `search topics`: a forum group's topics whose title matches, asked of the messenger. */
export const topicsSearchCommand = (messenger: Messenger): Command =>
  withPaging(
    new Command("topics")
      .description("a forum group's topics whose title matches")
      .argument("<chat>", messenger.chatArgument)
      .argument("<text>", "words from the topic's title"),
  ).action(listed(messenger))

/** `topics list` and the writes — a forum group's topics, with the ids its messages carry as `threadId`. */
export const topicsCommand = (messenger: Messenger): Command => {
  const topics = new Command("topics").description("the topics of a forum group")

  topics.addCommand(
    withPaging(
      new Command("list")
        .description("a forum group's topics, newest activity first")
        .argument("<chat>", messenger.chatArgument),
    ).action(listed(messenger)),
  )

  if (messenger.topicShow)
    topics
      .command("show")
      .description("one forum topic: its title, state and last activity")
      .argument("<chat>", messenger.chatArgument)
      .argument("<topic>", "the topic id, from `topics list`")
      .action(async function (this: Command, chat: string, topic: string) {
        const context = messengerContext(this, messenger)
        context.renderer.result(await context.withServices((services) => services.topics.show(chat, topic)))
      })

  annotate(topics.command("enable"), { mutates: true })
    .description("enable forum topics; only the owner, with an explicit upgrade for a basic group")
    .argument("<chat>", messenger.chatArgument)
    .option("--upgrade", "upgrade a basic group to a supergroup first; its chat id changes")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(
        await context.withServices((services) =>
          services.topics.enable(chat, { upgrade: this.opts<{ upgrade?: boolean }>().upgrade === true }),
        ),
      )
    })
  annotate(topics.command("create"), { mutates: true })
    .description("create a named topic in an existing forum; never enable or upgrade a group implicitly")
    .argument("<chat>", messenger.chatArgument)
    .argument("<title>", "the topic title, at most 128 UTF-8 bytes")
    .option("--send-id <id>", "identify this creation attempt; an already sent or unknown id is refused")
    .action(async function (this: Command, chat: string, title: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(
        await context.withServices((services) => services.topics.create(chat, title, this.opts<{ sendId?: string }>())),
      )
    })
  annotate(topics.command("edit"), { mutates: true })
    .description("rename, close or reopen a forum topic")
    .argument("<chat>", messenger.chatArgument)
    .argument("<topic>", "the topic id, from `topics list`")
    .option("--title <title>", "the new title, at most 128 UTF-8 bytes")
    .option("--closed <on|off>", "on closes the topic to new messages, off reopens it")
    .option("--pinned <on|off>", "on pins the topic at the top of the list, off unpins it")
    .option("--hidden <on|off>", "on hides the General topic from the topic list, off shows it")
    .action(async function (this: Command, chat: string, topic: string) {
      const context = messengerContext(this, messenger)
      const { title, closed, pinned, hidden } = this.opts<{
        title?: string
        closed?: string
        pinned?: string
        hidden?: string
      }>()
      const closes = onOff("--closed", closed)
      const pins = onOff("--pinned", pinned)
      const hides = onOff("--hidden", hidden)
      context.renderer.result(
        await context.withServices((services) =>
          services.topics.edit(chat, topic, {
            ...(title === undefined ? {} : { title }),
            ...(closes === undefined ? {} : { closed: closes }),
            ...(pins === undefined ? {} : { pinned: pins }),
            ...(hides === undefined ? {} : { hidden: hides }),
          }),
        ),
      )
    })
  annotate(topics.command("delete"), { mutates: true })
    .description("delete a forum topic and every message in it, for everyone; it cannot be undone")
    .argument("<chat>", messenger.chatArgument)
    .argument("<topic>", "the topic id, from `topics list`")
    .option("--allow-dangerous", "go ahead without the question an ask level puts before a deletion")
    .action(async function (this: Command, chat: string, topic: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(await context.withServices((services) => services.topics.delete(chat, topic)))
    })
  annotate(topics.command("order"), { mutates: true })
    .description("put the pinned topics in this order; it pins and unpins nothing")
    .argument("<chat>", messenger.chatArgument)
    .argument("<topic...>", "the pinned topics' ids, first to last")
    .action(async function (this: Command, chat: string, order: string[]) {
      const context = messengerContext(this, messenger)
      context.renderer.result(await context.withServices((services) => services.topics.order(chat, order)))
    })
  return topics
}

const onOff = (flag: string, value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined
  if (value !== "on" && value !== "off")
    throw new CliError("validation_error", `${flag} takes on or off, not "${value}"`)
  return value === "on"
}
