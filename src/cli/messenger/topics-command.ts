import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { topicIcon } from "../../entities/index.js"
import { capability } from "../../ports/messenger.js"
import { ownerOnlyOption, REMOTE_READ, REMOTE_WRITE } from "../effects.js"
import { itemOf, listOf, renderAnswer, snakeKeys } from "../envelope.js"
import { listQuery, typedQuery, unfilteredQuery, withQuery } from "../list-query.js"
import { window, withPaging } from "../paging.js"
import { lines, pageOf, topicAnswer, wholeList } from "./chat-answers.js"
import { type Messenger, messengerContext } from "./context.js"
import { TOPICS_QUERY, topicTitle } from "./list-result-queries.js"

const listed = (messenger: Messenger) =>
  async function (this: Command, chat: string, value?: string | string[]) {
    const searching = this.name() === "topics"
    const words = !searching && Array.isArray(value) ? value : []
    const query = searching && typeof value === "string" ? value : topicTitle(words)
    const context = messengerContext(this, messenger)
    if (context.settings.offline) {
      throw new CliError("validation_error", "`topics` asks the messenger; not with --offline")
    }
    const wanted = { ...window(context.settings), ...(query ? { search: query } : {}) }
    const found = await context.withMessenger((adapter) =>
      capability(adapter, "topics", "list forum topics")(chat, wanted),
    )
    const command = searching ? "search topics" : "topics list"
    renderAnswer(
      this,
      context,
      listOf(command, {
        items: found.items.map(topicAnswer),
        ...pageOf(context.settings, found),
        args: { chat, ...(searching ? { text: query } : typedQuery(words) ? { query: typedQuery(words) } : {}) },
      }),
      lines(({ id, title, closed, pinned, unread_count }) =>
        [id, title, closed ? "closed" : "", pinned ? "pinned" : "", unread_count ? `${unread_count} unread` : ""].join(
          "  ",
        ),
      ),
    )
  }

/** `search topics`: a forum group's topics whose title matches, asked of the messenger. */
export const topicsSearchCommand = (messenger: Messenger): Command =>
  withPaging(
    annotate(new Command("topics"), { effects: REMOTE_READ, offline: false })
      .description("a forum group's topics whose title matches")
      .argument("<chat>", messenger.chatArgument)
      .argument("<text>", "words from the topic's title"),
  ).action(listed(messenger))

/** `topics list` and the writes — a forum group's topics, with the ids its messages carry as `threadId`. */
export const topicsCommand = (messenger: Messenger): Command => {
  const topics = annotate(new Command("topics"), { offline: false }).description("the topics of a forum group")

  topics.addCommand(
    withQuery(
      withPaging(
        annotate(new Command("list"), { effects: REMOTE_READ })
          .description("a forum group's topics, newest activity first")
          .argument("<chat>", messenger.chatArgument),
      ),
      TOPICS_QUERY,
    ).action(listed(messenger)),
  )

  if (messenger.topicShow)
    annotate(topics.command("show"), { effects: REMOTE_READ })
      .description("one forum topic: its title, state and last activity")
      .argument("<chat>", messenger.chatArgument)
      .argument("<topic>", "the topic id, from `topics list`")
      .action(async function (this: Command, chat: string, topic: string) {
        const context = messengerContext(this, messenger)
        const shown = await context.withServices((services) => services.topics.show(chat, topic))
        renderAnswer(this, context, itemOf(topicAnswer(shown)))
      })

  const icons = new Command("icons").description("the emojis a forum topic can take as its icon")
  topics.addCommand(icons)
  icons.addCommand(
    withQuery(
      annotate(new Command("list"), {
        effects: REMOTE_READ,
        examples: [`${messenger.app.command} personal topics icons list`],
      }).description("the emojis `--emoji` takes in topics create and topics edit"),
      TOPIC_ICONS_QUERY,
    ).action(async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger)
      listQuery(typedQuery(words), TOPIC_ICONS_QUERY, "topics icons list")
      const icons = await context.withServices((services) => services.topics.icons())
      renderAnswer(
        this,
        context,
        wholeList(
          "topics icons list",
          icons.map((emoji) => ({ emoji })),
        ),
        lines(({ emoji }) => emoji),
      )
    }),
  )

  annotate(topics.command("enable"), { effects: REMOTE_WRITE })
    .description("enable forum topics; only the owner, with an explicit upgrade for a basic group")
    .argument("<chat>", messenger.chatArgument)
    .option("--upgrade", "upgrade a basic group to a supergroup first; its chat id changes")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const done = await context.withServices((services) =>
        services.topics.enable(chat, { upgrade: this.opts<{ upgrade?: boolean }>().upgrade === true }),
      )
      renderAnswer(this, context, itemOf(snakeKeys(done)))
    })
  annotate(topics.command("create"), { effects: REMOTE_WRITE })
    .description("create a named topic in an existing forum; never enable or upgrade a group implicitly")
    .argument("<chat>", messenger.chatArgument)
    .argument("<title>", "the topic title, at most 128 UTF-8 bytes")
    .option("--operation-id <id>", "identify this creation attempt; an already sent or unknown id is refused")
    .option("--emoji <emoji>", "the topic's icon, one of `topics icons list`")
    .action(async function (this: Command, chat: string, title: string) {
      const context = messengerContext(this, messenger)
      const { operationId, emoji } = this.opts<{ operationId?: string; emoji?: string }>()
      const created = await context.withServices((services) =>
        services.topics.create(chat, title, { sendId: operationId, ...(emoji === undefined ? {} : { icon: emoji }) }),
      )
      renderAnswer(this, context, itemOf(snakeKeys(created)))
    })
  annotate(topics.command("edit"), { effects: REMOTE_WRITE })
    .description("rename, close, reopen or give an icon to a forum topic")
    .argument("<chat>", messenger.chatArgument)
    .argument("<topic>", "the topic id, from `topics list`")
    .option("--title <title>", "the new title, at most 128 UTF-8 bytes")
    .option("--closed <on|off>", "on closes the topic to new messages, off reopens it")
    .option("--pinned <on|off>", "on pins the topic at the top of the list, off unpins it")
    .option("--hidden <on|off>", "on hides the General topic from the topic list, off shows it")
    .option("--emoji <emoji>", "the topic's icon, one of `topics icons list`; none removes it")
    .action(async function (this: Command, chat: string, topic: string) {
      const context = messengerContext(this, messenger)
      const { title, closed, pinned, hidden, emoji } = this.opts<{
        title?: string
        closed?: string
        pinned?: string
        hidden?: string
        emoji?: string
      }>()
      const closes = onOff("--closed", closed)
      const pins = onOff("--pinned", pinned)
      const hides = onOff("--hidden", hidden)
      const done = await context.withServices((services) =>
        services.topics.edit(chat, topic, {
          ...(title === undefined ? {} : { title }),
          ...(closes === undefined ? {} : { closed: closes }),
          ...(pins === undefined ? {} : { pinned: pins }),
          ...(hides === undefined ? {} : { hidden: hides }),
          ...(emoji === undefined ? {} : { icon: emoji === "none" ? null : emoji }),
        }),
      )
      renderAnswer(this, context, itemOf(snakeKeys(done)))
    })
  annotate(topics.command("delete"), { effects: REMOTE_WRITE })
    .description("delete a forum topic and every message in it, for everyone; it cannot be undone")
    .argument("<chat>", messenger.chatArgument)
    .argument("<topic>", "the topic id, from `topics list`")
    .addOption(
      ownerOnlyOption("--allow-dangerous", "go ahead without the question an ask level puts before a deletion"),
    )
    .action(async function (this: Command, chat: string, topic: string) {
      const context = messengerContext(this, messenger)
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(await context.withServices((services) => services.topics.delete(chat, topic)))),
      )
    })
  annotate(topics.command("order"), { effects: REMOTE_WRITE })
    .description("put the pinned topics in this order; it pins and unpins nothing")
    .argument("<chat>", messenger.chatArgument)
    .argument("<topic...>", "the pinned topics' ids, first to last")
    .action(async function (this: Command, chat: string, order: string[]) {
      const context = messengerContext(this, messenger)
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(await context.withServices((services) => services.topics.order(chat, order)))),
      )
    })
  return topics
}

const TOPIC_ICONS_QUERY = unfilteredQuery("topic_icon", topicIcon)

const onOff = (flag: string, value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined
  if (value !== "on" && value !== "off")
    throw new CliError("validation_error", `${flag} takes on or off, not "${value}"`)
  return value === "on"
}
