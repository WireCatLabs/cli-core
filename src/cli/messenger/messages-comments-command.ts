import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { renderMessages } from "../../render/messages.js"
import { REMOTE_READ } from "../effects.js"
import { listOf, renderAnswer } from "../envelope.js"
import { queryHelp } from "../list-query.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"
import { COMMENTS_QUERY, cursorOf, historyWindow } from "./history-query.js"
import { messageItems, viewOf } from "./message-items.js"

export const commentsCommand = (messenger: Messenger): Command => {
  const otherPosts = messenger.readsComments === true && messenger.channelComments === false
  const command = annotate(new Command("comments"), {
    examples: [
      `${messenger.app.command} personal messages comments "${otherPosts ? "Announcements" : "News channel"}" 101 --limit 20`,
    ],
    effects: REMOTE_READ,
  })
    .summary(otherPosts ? "comments on a post" : "comments on a channel post")
    .description(
      otherPosts
        ? "the comments received under a post, oldest to newest"
        : "the comments under a channel post, oldest to newest; they live in its discussion group",
    )
    .addHelpText("after", queryHelp(COMMENTS_QUERY))
    .argument("<chat>", `the ${otherPosts ? "chat" : "channel"}: ${messenger.chatArgument}`)
    .argument("<post>", otherPosts ? "the post's message id in the chat" : "the post's message id in the channel")
    .argument("[query...]", "where to start: id<42")
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .option("--cursor <cursor>", "go on from where the last page stopped; page.next gives it")
    .action(async function (this: Command, chat: string, post: string, query: string[]) {
      const context = messengerContext(this, messenger)
      const { cursor } = this.opts<{ cursor?: string }>()
      const window = historyWindow(query, cursor, "messages comments", COMMENTS_QUERY)
      if (window.after !== undefined || window.beforeTime !== undefined)
        throw new CliError("validation_error", "comments are read back from the newest: id< only")
      const { limit } = context.settings
      const { found, reader } = await context.withServices(async (services) => ({
        found: await services.messages.comments(chat, post, {
          limit,
          ...(window.before === undefined ? {} : { before: window.before }),
        }),
        reader: await services.messages.reader(),
      }))
      const next = found.hasMore ? cursorOf(window, { first: found.items[0]?.id }) : undefined
      renderAnswer(
        this,
        context,
        listOf("messages comments", {
          items: messageItems(found.items, reader),
          limit,
          has_more: found.hasMore,
          paging: "cursor",
          ...(next === undefined ? {} : { cursor: next }),
          args: { chat, post, ...(query.length > 0 ? { query: query.join(" ") } : {}) },
        }),
        () => renderMessages(found.items, viewOf(context, messenger)),
      )
    })
  return annotate(command, { output: { entity: "message" }, query: COMMENTS_QUERY })
}
