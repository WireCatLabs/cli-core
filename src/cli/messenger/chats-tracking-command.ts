import { Command } from "commander"
import { TRACKED_DAYS } from "../../services/chats.js"
import { itemOf, renderAnswer } from "../envelope.js"
import { lines, snakeKeys, wholeList } from "./chat-answers.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"

interface TrackedAnswer {
  chat_id: string
  title: string | null
  tracked_at: string
  last_count: { day: string; participants: number | null; complete: boolean } | null
}

/** The chats whose member lists `serve` fetches daily; kept in the local store, never sent. */
export const trackingCommand = (messenger: Messenger): Command => {
  const tracking = new Command("tracking").description(
    "the chats whose member lists serve fetches daily into the local store — chats members fetch --track adds one",
  )

  tracking
    .command("list")
    .description("every tracked chat: since when, and its last member count")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) => services.chats.tracked())
      renderAnswer(
        this,
        context,
        wholeList(
          "chats tracking list",
          found.map((one) => snakeKeys(one) as TrackedAnswer),
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

  tracking
    .command("show")
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
    tracking
      .command(verb)
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
