import { Command } from "commander"
import { CHAT_KINDS, type ChatFilter, checkedFilter, EVENTS_DAYS } from "../../services/chats.js"
import { momentOf } from "../../services/moment.js"
import { listed, renderPage, window, withPaging } from "../paging.js"
import { groupCommands } from "./admin-commands.js"
import { foldersCommand } from "./admin-folders-command.js"
import { moderateCommand, rulesCommand } from "./admin-moderation-command.js"
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
    withPaging(new Command("list").description("chats, newest first, archived ones included"))
      .option("--search <text>", "only chats whose name contains this; at least 3 characters")
      .option("--kind <kind>", `only chats of this kind: ${CHAT_KINDS.join(", ")}`)
      .option("--unread", "only chats with unread messages")
      .action(async function (this: Command) {
        const context = messengerContext(this, messenger)
        const filter = checkedFilter(this.opts<ChatFilter>())
        const wanted = window(context.settings)
        const page = await context.withServices((services) => services.chats.list(filter, wanted))
        if (page.partial) {
          context.renderer.note(
            "the messenger did not list every chat, and did not say how many it left out; one may match too",
          )
        }
        renderPage(context, {
          ...page,
          items:
            context.format === "pretty"
              ? page.items.map(({ id, title, kind, unreadCount, lastMessageAt }) => ({
                  id,
                  title,
                  kind,
                  unreadCount,
                  lastMessageAt,
                }))
              : page.items,
        })
      }),
  )

  chats
    .command("events")
    .description("who joined, left, was added or removed, and by whom — from the chat's service messages")
    .argument("<chat>", messenger.chatArgument)
    .option("--since-time <time>", `ISO 8601, or 2h / 1d ago; ${EVENTS_DAYS} days ago if not given`)
    .option("--type <names>", "only these, comma-separated: join, leave, add, remove, create, title, pin")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { sinceTime: since, type } = this.opts<{ sinceTime?: string; type?: string }>()
      const found = await context.withServices((services) =>
        services.chats.events(chat, {
          ...(since === undefined ? {} : { since: momentOf(since, "--since-time") }),
          ...(type ? { only: type } : {}),
        }),
      )
      if (context.format === "jsonl") context.renderer.stream(found.events)
      else if (context.format !== "pretty") {
        const { events, more, ...rest } = found
        context.renderer.result({ ...listed(events), hasMore: more, ...rest })
      } else {
        context.renderer.stream(
          found.events.map((one) => ({
            time: one.timestamp,
            event: one.event,
            by: one.by.name ?? one.by.id,
            people: one.people.map((person) => person.name ?? person.id).join(", "),
          })),
        )
      }
      if (found.more) context.renderer.note("more history than one run reads — adjust --since-time to read more")
    })

  chats
    .command("inspect")
    .description("what an invite or public link leads to, without joining it")
    .argument("<link>", "an invite link or a public one")
    .action(async function (this: Command, link: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(await context.withServices((services) => services.chats.inspect(link)))
    })

  chats
    .command("show")
    .description("one chat: its kind, unread count, last message time and who is in it")
    .argument("<chat>", messenger.chatArgument)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const card = await context.withServices((services) => services.chats.show(chat))
      context.renderer.result(card)
      const { members, participantsCount } = card
      if (members && participantsCount !== null && members.length < participantsCount) {
        context.renderer.note(
          `${members.length} listed members; the chat reports ${participantsCount} participants. The list may omit your account or be partial.`,
        )
      }
    })

  chats
    .command("send-as")
    .description("who this account may post as in a chat; changes no saved choice")
    .argument("<chat>", messenger.chatArgument)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const identities = await context.withServices((services) => services.chats.sendAs(chat))
      if (context.format === "json") context.renderer.result(listed(identities))
      else context.renderer.stream(identities)
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
