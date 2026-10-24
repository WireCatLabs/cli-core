import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { ADMIN_RIGHTS } from "../../domain/models.js"
import { guardedWrite } from "../../sends/guarded.js"
import { newOperationId } from "../../sends/send-id.js"
import { REMOTE_READ, REMOTE_WRITE } from "../effects.js"
import { renderAnswer, snakeKeys } from "../envelope.js"
import { listQuery, typedQuery, withQuery } from "../list-query.js"
import { rightsOf } from "../messenger/admin-commands.js"
import { renderItem, wholeList } from "../messenger/chat-answers.js"
import { botContext, online } from "./context.js"
import { botExamples } from "./examples.js"
import { BOT_ADMINS_QUERY } from "./list-queries.js"
import { botCan } from "./messages.js"
import type { BotMessenger } from "./port.js"

const CHAT = "a chat id, or the title of a chat this bot has seen"
const PERSON = "the person's user id"

/** Neither Bot API finds a person by name, so a person is their id. */
const personOf = (typed: string): string => {
  const id = typed.trim()
  if (!/^\d+$/.test(id)) throw new CliError("validation_error", `a person is their user id, digits only — not ${typed}`)
  return id
}

/** `bot chats admins`: who runs a chat the bot is an admin in, under the personal account's names. */
export const botAdminsCommand = (bot: BotMessenger): Command => {
  const offered = bot.adminRights ?? ADMIN_RIGHTS
  const command = new Command("admins").description("the admins of a chat the bot is an admin in")

  withQuery(
    annotate(command.command("list"), { effects: REMOTE_READ, examples: botExamples(bot, "chats admins list Team") })
      .description("the chat's admins and what each may do")
      .argument("<chat>", CHAT),
    BOT_ADMINS_QUERY,
  ).action(async function (this: Command, chat: string, words: string[]) {
    listQuery(typedQuery(words), BOT_ADMINS_QUERY, "bot chats admins list")
    const context = online(botContext(this, bot), this)
    const ref = context.chatRef(chat)
    await context.run(async (events) => {
      const adapter = await context.authenticated({ events })
      const admins = await botCan(adapter, "admins", bot, "list a chat's admins")(ref)
      renderAnswer(this, context, wholeList("bot chats admins list", admins.map(snakeKeys)))
    })
  })

  annotate(command.command("add"), {
    effects: REMOTE_WRITE,
    examples: botExamples(bot, "chats admins add Team 42 --title Helper"),
  })
    .description("make a member an admin with these rights")
    .argument("<chat>", CHAT)
    .argument("<person>", PERSON)
    .requiredOption("--can <rights>", `what they may do, comma-separated: ${offered.join(", ")}`)
    .option("--title <title>", "the title shown beside their name")
    .action(async function (this: Command, chat: string, person: string) {
      const context = online(botContext(this, bot), this)
      const ref = context.chatRef(chat)
      const personId = personOf(person)
      const { can, title } = this.opts<{ can: string; title?: string }>()
      const rights = rightsOf(offered, can)
      await context.run(async (events) => {
        const adapter = await context.authenticated({ events })
        const add = botCan(adapter, "addAdmin", bot, "make an admin")
        const operationId = newOperationId()
        await guardedWrite(
          context.guard(),
          { operationId, chatId: ref, kind: "chat", action: "admins.add", key: "bot.chats.admins.add" },
          () => add(ref, personId, rights, title === undefined ? {} : { title }),
        )
        renderItem(this, context, {
          operationId,
          chatId: ref,
          personId,
          rights,
          ...(title === undefined ? {} : { title }),
        })
      })
    })

  annotate(command.command("remove"), {
    effects: REMOTE_WRITE,
    examples: botExamples(bot, "chats admins remove Team 42"),
  })
    .description("take an admin's rights back; they stay a member")
    .argument("<chat>", CHAT)
    .argument("<person>", PERSON)
    .action(async function (this: Command, chat: string, person: string) {
      const context = online(botContext(this, bot), this)
      const ref = context.chatRef(chat)
      const personId = personOf(person)
      await context.run(async (events) => {
        const adapter = await context.authenticated({ events })
        const remove = botCan(adapter, "removeAdmin", bot, "take admin rights back")
        const operationId = newOperationId()
        await guardedWrite(
          context.guard(),
          { operationId, chatId: ref, kind: "chat", action: "admins.remove", key: "bot.chats.admins.remove" },
          () => remove(ref, personId),
        )
        renderItem(this, context, { operationId, chatId: ref, personId })
      })
    })

  return command
}

/**
 * `bot chats members`: `remove`, which both Bot APIs have. A CLI whose bot can list or add members
 * adds those commands to this group.
 */
export const botMembersCommand = (bot: BotMessenger): Command => {
  const command = new Command("members").description("the people in a chat the bot is an admin in")

  annotate(command.command("remove"), {
    effects: REMOTE_WRITE,
    examples: botExamples(bot, "chats members remove Team 42 --block"),
  })
    .description("take a person out of a chat; their messages stay")
    .argument("<chat>", CHAT)
    .argument("<person>", PERSON)
    .option("--block", "also keep them from coming back by the chat's link")
    .action(async function (this: Command, chat: string, person: string) {
      const context = online(botContext(this, bot), this)
      const ref = context.chatRef(chat)
      const personId = personOf(person)
      const block = this.opts<{ block?: boolean }>().block === true
      await context.run(async (events) => {
        const adapter = await context.authenticated({ events })
        const remove = botCan(adapter, "removeMember", bot, "remove people from a chat")
        const operationId = newOperationId()
        await guardedWrite(
          context.guard(),
          {
            operationId,
            chatId: ref,
            kind: "chat",
            action: "members.remove",
            key: "bot.chats.members.remove",
            people: 1,
          },
          () => remove(ref, personId, { block }),
        )
        renderItem(this, context, { operationId, chatId: ref, removed: [personId], blocked: block })
      })
    })

  return command
}
