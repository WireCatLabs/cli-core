import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { TRACKED_DAYS } from "../../services/chats.js"
import { LOCAL_READ, LOCAL_WRITE } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { listQuery, typedQuery, withQuery } from "../list-query.js"
import { lines, wholeList } from "./chat-answers.js"
import { TRACKING_QUERY } from "./chat-queries.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"

/** The chats whose member lists `serve` fetches daily; kept in the local store, never sent. */
export const trackingCommand = (messenger: Messenger): Command => {
  const tracking = new Command("tracking")
    .summary("chats whose member lists are fetched daily")
    .description(
      "the chats whose member lists serve fetches daily into the local store — chats members fetch --track adds one",
    )

  withQuery(annotate(tracking.command("list"), { effects: LOCAL_READ }), TRACKING_QUERY)
    .description("every tracked chat: since when, and its last member count")
    .action(async function (this: Command, words: string[]) {
      const query = listQuery(typedQuery(words), TRACKING_QUERY, "chats tracking list")
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) => services.chats.tracked(query))
      renderAnswer(
        this,
        context,
        wholeList(
          "chats tracking list",
          found.map(({ chatId, title, trackedAt, lastCount }) => ({
            chat_id: chatId,
            title,
            tracked_at: trackedAt,
            last_count: lastCount,
          })),
        ),
        lines(({ chat_id, title, tracked_at, last_count }) =>
          [
            title ? `${title} (${chat_id})` : chat_id,
            tracked_at.slice(0, 10),
            last_count
              ? `${last_count.day}: ${last_count.participants ?? "?"}${last_count.complete ? "" : " (partial)"}`
              : "",
          ].join("  "),
        ),
      )
    })

  annotate(tracking.command("show"), { effects: LOCAL_READ, output: { entity: "tracked_chat_history" } })
    .summary("one chat's member tracking and daily counts")
    .description(`one chat: whether it is tracked, and its member count per day for the last ${TRACKED_DAYS} days`)
    .argument("<chat>", messenger.chatArgument)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      renderAnswer(
        this,
        context,
        itemOf(snakeKeys(await context.withServices((services) => services.chats.trackedChat(chat)))),
      )
    })

  for (const [verb, tracked, description] of [
    ["add", true, "fetch this chat's member list daily while serve runs, from its next run"],
    ["remove", false, "stop fetching it daily; the history already kept stays"],
  ] as const) {
    annotate(tracking.command(verb), { effects: LOCAL_WRITE, output: { entity: "chat_tracking" } })
      .description(description)
      .argument("<chat>", messenger.chatArgument)
      .action(async function (this: Command, chat: string) {
        const context = messengerContext(this, messenger)
        refuseLocalWrite(context, messenger.app.command, `chats.tracking.${verb}`)
        renderAnswer(
          this,
          context,
          itemOf(snakeKeys(await context.withServices((services) => services.chats.track(chat, tracked)))),
        )
      })
  }

  return tracking
}
