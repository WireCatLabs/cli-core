import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { capability } from "../../ports/messenger.js"
import { REMOTE_READ, REMOTE_WRITE } from "../effects.js"
import { itemOf, listOf, renderAnswer, snakeKeys } from "../envelope.js"
import { listQuery, nativeTerms, typedQuery, withQuery } from "../list-query.js"
import { positiveCount } from "../paging.js"
import { lines, reactorAnswer } from "./chat-answers.js"
import { type Messenger, messengerContext } from "./context.js"
import { REACTORS_QUERY } from "./people-queries.js"

/** `reactions add|remove`: the owner's own reaction on a message. */
export const reactionsCommand = (messenger: Messenger): Command => {
  const reactions = new Command("reactions").description("react to messages")

  if (messenger.reactionsList)
    reactions.addCommand(
      withQuery(
        annotate(
          annotate(new Command("list"), {
            effects: REMOTE_READ,
            examples: [`${messenger.app.command} personal reactions list "Book club" 101 reaction:🔥 --limit 20`],
          })
            .description("who reacted to a message, newest first; refused where the chat hides the list")
            .argument("<chat>", messenger.chatArgument)
            .argument("<message>", "the message id")
            .option("--limit <n>", "how many to show", positiveCount("--limit"))
            .option("--cursor <cursor>", "go on from where the last page stopped; page.next gives it"),
          { output: { entity: "reaction" } },
        ),
        REACTORS_QUERY,
      ).action(async function (this: Command, chat: string, message: string, words: string[]) {
        const emoji = nativeTerms(listQuery(typedQuery(words), REACTORS_QUERY, "reactions list"), "reactions list").get(
          "reaction",
        )?.value
        const context = messengerContext(this, messenger)
        const { cursor } = this.opts<{ cursor?: string }>()
        const { limit } = context.settings
        const found = await context.withMessenger(async (connection) => {
          const list = capability(connection, "reactors", "list who reacted")
          return list((await connection.resolve(chat)).id, message.trim(), {
            limit,
            ...(emoji === undefined ? {} : { emoji: emoji.trim() }),
            ...(cursor === undefined ? {} : { cursor }),
          })
        })
        renderAnswer(
          this,
          context,
          listOf("reactions list", {
            items: found.items.map(reactorAnswer),
            limit,
            has_more: found.hasMore,
            paging: "cursor",
            ...(found.cursor === undefined ? {} : { cursor: found.cursor }),
            args: { chat, message, ...(words.length > 0 ? { query: words.join(" ") } : {}) },
          }),
          lines(({ reacted_at, person, reaction: name }) => [reacted_at, person.name ?? person.id, name].join("  ")),
        )
      }),
    )

  annotate(reactions.command("add"), {
    effects: REMOTE_WRITE,
    output: { entity: "reaction_change" },
    examples: [`${messenger.app.command} personal reactions add "Book club" 101 👍`],
  })
    .description("put your reaction on a message; it replaces the one you had")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the message id")
    .argument("<emoji>", "one emoji, for example 👍")
    .action(async function (this: Command, chat: string, message: string, emoji: string) {
      const context = messengerContext(this, messenger)
      const reacted = await context.withServices((services) =>
        services.messages.react({ chat, message: message.trim(), emoji: emoji.trim() }),
      )
      renderAnswer(this, context, itemOf(snakeKeys(reacted)))
    })

  annotate(reactions.command("remove"), {
    effects: REMOTE_WRITE,
    output: { entity: "reaction_change" },
    examples: [`${messenger.app.command} personal reactions remove "Book club" 101`],
  })
    .description("take your reaction off a message")
    .argument("<chat>", messenger.chatArgument)
    .argument("<message>", "the message id")
    .action(async function (this: Command, chat: string, message: string) {
      const context = messengerContext(this, messenger)
      const reacted = await context.withServices((services) =>
        services.messages.react({ chat, message: message.trim(), emoji: null }),
      )
      renderAnswer(this, context, itemOf(snakeKeys(reacted)))
    })

  return reactions
}
