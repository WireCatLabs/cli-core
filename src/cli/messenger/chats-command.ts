import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { EVENTS_DAYS } from "../../services/chats.js"
import { REMOTE_READ } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { withQuery } from "../list-query.js"
import { withPaging } from "../paging.js"
import { groupCommands } from "./admin-commands.js"
import { foldersCommand } from "./admin-folders-command.js"
import { moderateCommand, rulesCommand } from "./admin-moderation-command.js"
import { chatShown, lines, wholeList } from "./chat-answers.js"
import { chatEvents, chatsList } from "./chat-lists.js"
import { CHATS_QUERY, EVENTS_QUERY } from "./chat-queries.js"
import { botChatCommands } from "./chats-bots-command.js"
import { documentsCommand } from "./chats-documents-command.js"
import { membersCommand } from "./chats-members-command.js"
import { markReadCommand } from "./chats-read-command.js"
import { trackingCommand } from "./chats-tracking-command.js"
import { type Messenger, messengerContext } from "./context.js"
import { chatDeletionCommands, mediaCommand, muteCommands } from "./records-command.js"

export const chatsCommand = (messenger: Messenger): Command => {
  const chats = new Command("chats").description("the account's chats")

  chats.addCommand(
    withQuery(
      annotate(
        withPaging(
          annotate(new Command("list"), { effects: REMOTE_READ })
            .summary("chats, newest first, archived ones included")
            .description(
              "chats, newest first, archived ones included; the query is answered from the local store, " +
                "so online, where the messenger filters nothing, it needs --offline",
            ),
        ),
        {
          output: { entity: "chat" },
        },
      ),
      CHATS_QUERY,
    ).action(async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger)
      const body = await context.withServices((services) => chatsList(services, words, context.settings))
      renderAnswer(
        this,
        context,
        body,
        lines(({ id, title, kind, unread_count, last_message_at }) =>
          [id, kind, title ?? "", unread_count ? `${unread_count} unread` : "", last_message_at ?? ""].join("  "),
        ),
      )
    }),
  )

  chats.addCommand(
    withQuery(
      annotate(
        annotate(new Command("events"), { effects: REMOTE_READ })
          .description(
            "who joined, left, was added or removed, and by whom — from the chat's service messages; " +
              `the last ${EVENTS_DAYS} days unless the query names time`,
          )
          .argument("<chat>", messenger.chatArgument),
        { output: { entity: "chat_event" } },
      ),
      EVENTS_QUERY,
    ).action(async function (this: Command, chat: string, words: string[]) {
      const context = messengerContext(this, messenger)
      const body = await context.withServices((services) => chatEvents(services, chat, words))
      renderAnswer(
        this,
        context,
        body,
        lines(({ time, type, by, people }) =>
          [time, type, by?.name ?? by?.id ?? "", people.map((one) => one.name ?? one.id).join(", ")].join("  "),
        ),
      )
      if (body.meta?.truncated) context.renderer.note("more history than one run reads; a later time bound reads less")
    }),
  )

  annotate(chats.command("inspect"), { effects: REMOTE_READ })
    .description("what an invite or public link leads to, without joining it")
    .argument("<link>", "an invite link or a public one")
    .action(async function (this: Command, link: string) {
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) => services.chats.inspect(link))
      renderAnswer(this, context, itemOf(snakeKeys(found)))
    })

  chats.addCommand(
    annotate(
      annotate(new Command("show"), { effects: REMOTE_READ })
        .description("one chat: its kind, unread count, last message time and who is in it")
        .argument("<chat>", messenger.chatArgument),
      { output: { entity: "chat" } },
    ).action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { card, account } = await context.withServices(async (services) => ({
        card: await services.chats.show(chat),
        account: await services.chats.account(),
      }))
      renderAnswer(this, context, chatShown(account, card))
    }),
  )

  annotate(chats.command("send-as"), { effects: REMOTE_READ })
    .description("who this account may post as in a chat; changes no saved choice")
    .argument("<chat>", messenger.chatArgument)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const identities = await context.withServices((services) => services.chats.sendAs(chat))
      renderAnswer(this, context, wholeList("chats send-as", identities.map(snakeKeys)))
    })

  chats.addCommand(documentsCommand(messenger))
  chats.addCommand(membersCommand(messenger))
  chats.addCommand(markReadCommand(messenger))
  chats.addCommand(trackingCommand(messenger))
  for (const command of groupCommands(messenger)) chats.addCommand(command)
  chats.addCommand(foldersCommand(messenger))
  chats.addCommand(rulesCommand(messenger))
  chats.addCommand(moderateCommand(messenger))
  if (messenger.chatMedia === true) chats.addCommand(mediaCommand(messenger))
  if (messenger.chatMute === true) for (const command of muteCommands(messenger)) chats.addCommand(command)
  if (messenger.chatDeletion === true) for (const command of chatDeletionCommands(messenger)) chats.addCommand(command)
  if (messenger.personalBots === true) for (const command of botChatCommands(messenger)) chats.addCommand(command)

  return chats
}
