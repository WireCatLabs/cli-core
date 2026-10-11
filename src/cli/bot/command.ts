import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Argument, Command } from "commander"
import { guardedWrite } from "../../sends/guarded.js"
import { newOperationId } from "../../sends/send-id.js"
import { envName } from "../app.js"
import { renderList } from "../paging.js"
import { botAdminsCommand, botMembersCommand } from "./admins.js"
import { botContext, online } from "./context.js"
import { botMcpCommand } from "./mcp.js"
import { botCan, botIdOf, botMessagesCommand } from "./messages.js"
import { botModerateCommand, botRulesCommand } from "./moderation.js"
import { addBotCopyReads, botContactsCommand, botSearchCommand } from "./people.js"
import { BOT_ACTIONS, type BotAction, type BotMessenger } from "./port.js"
import { registryProfiles } from "./registry.js"
import { botCallbacksCommand, botMenuCommand, botWebhooksCommand } from "./setup.js"
import { botStoreCommand } from "./store.js"
import { BotTokenStore } from "./token.js"
import { botWatchCommand } from "./watch.js"

const authCommand = (bot: BotMessenger, tokenVariable: string): Command => {
  const auth = new Command("auth").description("the bot token this profile uses")

  annotate(auth.command("set"), { mutates: true, local: true })
    .description(
      `check a bot token with ${bot.name ?? "the messenger"}, then keep it — typed at a hidden prompt or piped on stdin`,
    )
    .action(async function (this: Command) {
      const context = online(botContext(this, bot), this)
      await context.run(async (events) => {
        const token = (await context.readSecret("Bot token: ")).trim()
        if (!token) throw new CliError("validation_error", "no token given")
        const account = await (await context.connect(token, { events })).me()
        const stored = context.tokens.write(token)
        context.registry.touch()
        if (context.env[tokenVariable]) {
          context.streams.diagnostic(`${tokenVariable} is set, and it wins over the token just kept until it is unset`)
        }
        context.renderer.result({
          profile: context.profile,
          stored,
          bot: account.name,
          id: account.id,
          username: account.username,
        })
      })
    })

  auth
    .command("show")
    .description("where this profile's bot token comes from, and which bot it is")
    .action(async function (this: Command) {
      const context = online(botContext(this, bot), this)
      await context.run(async (events) => {
        const source = context.tokens.read()?.source
        const account = await (await context.authenticated({ events })).me()
        context.renderer.result({
          profile: context.profile,
          source,
          bot: account.name,
          id: account.id,
          username: account.username,
        })
      })
    })

  annotate(auth.command("remove"), { mutates: true, local: true })
    .description("forget this profile's bot token")
    .action(async function (this: Command) {
      const context = botContext(this, bot)
      await context.run(async () =>
        context.renderer.result({ profile: context.profile, removed: context.tokens.remove() }),
      )
    })

  return auth
}

const meCommand = (bot: BotMessenger): Command =>
  new Command("me")
    .description("the bot this profile's token belongs to: id, name and username")
    .action(async function (this: Command) {
      const context = online(botContext(this, bot), this)
      await context.run(async (events) => {
        const adapter = await context.authenticated({ events })
        try {
          context.renderer.result(await adapter.me())
        } finally {
          await adapter.close()
        }
      })
    })

const listCommand = (bot: BotMessenger, tokenVariable: string): Command =>
  new Command("list")
    .description(
      `every name on this machine that has a bot token; --check asks ${bot.name ?? "the messenger"} which bot each is`,
    )
    .option("--check", "ask the messenger who each bot is, with its token")
    .action(async function (this: Command) {
      const context = botContext(this, bot)
      const check = this.opts<{ check?: boolean }>().check === true
      if (check) online(context, this)
      await context.run(async (events) => {
        const names = [
          ...new Set(["default", ...context.settings.configuredProfiles, ...registryProfiles(bot.app, context.env)]),
        ].sort()
        if (context.env[tokenVariable]) {
          context.streams.diagnostic(`${tokenVariable} is set, so every name uses that one token`)
        }
        const rows = []
        for (const name of names) {
          const tokens =
            bot.tokenStore?.(this, name) ?? new BotTokenStore({ app: bot.app, profile: name, env: context.env })
          const stored = tokens.read()
          if (!stored) continue
          const row: Record<string, unknown> = { name, token: stored.source }
          if (check) {
            try {
              const account = await (await context.connect(stored.token, { events })).me()
              Object.assign(row, { bot: account.username ?? account.name, id: account.id })
            } catch (error) {
              row.problem = (error as { code?: string }).code ?? "failed"
            }
          }
          rows.push(row)
        }
        renderList(context.renderer, context.format, rows)
      })
    })

const recipientsCommand = (bot: BotMessenger): Command => {
  const command = new Command("recipients").description(
    "the chats this bot may write to; with no list, every chat — `clear` removes the list",
  )
  command
    .command("list")
    .description("the chats on the list, or nothing when there is no list")
    .action(async function (this: Command) {
      const context = botContext(this, bot)
      await context.run(async () => renderList(context.renderer, context.format, context.recipients().read() ?? []))
    })
  annotate(command.command("add <chat>"), { mutates: true, local: true })
    .description("allow a chat: its id, `user:<id>`, or the title of a chat this bot has seen")
    .action(async function (this: Command, chat: string) {
      const context = botContext(this, bot)
      await context.run(async () => {
        const id = context.chatRef(chat)
        const title = context.registry.list().find((seen) => seen.id === id)?.title ?? null
        context.recipients().add({ id, title, addedAt: new Date().toISOString() })
        renderList(context.renderer, context.format, context.recipients().read() ?? [])
      })
    })
  annotate(command.command("remove <chat>"), { mutates: true, local: true })
    .description("take a chat off the list")
    .action(async function (this: Command, chat: string) {
      const context = botContext(this, bot)
      await context.run(async () => context.renderer.result({ removed: context.recipients().remove(chat) ?? null }))
    })
  annotate(command.command("clear"), { mutates: true, local: true })
    .description("remove the list: the bot may write to any chat again")
    .action(async function (this: Command) {
      const context = botContext(this, bot)
      await context.run(async () => context.renderer.result({ removed: context.recipients().off() }))
    })
  return command
}

const sendsCommand = (bot: BotMessenger): Command =>
  new Command("sends")
    .description("what this bot sent, edited and deleted from this machine — ids and outcomes, never text")
    .addCommand(
      new Command("list").action(async function (this: Command) {
        const context = botContext(this, bot)
        await context.run(async () => renderList(context.renderer, context.format, context.journal().entries()))
      }),
    )

const chatsCommand = (bot: BotMessenger): Command => {
  const command = new Command("chats").description(
    `the chats this bot is in — ${bot.name ?? "the messenger"} gives a bot no list of them, so \`list\` shows the ones it has seen`,
  )
  command
    .command("list")
    .description(`chats this bot has seen on this machine — not a complete list from ${bot.name ?? "the messenger"}`)
    .action(async function (this: Command) {
      const context = botContext(this, bot)
      await context.run(async () => renderList(context.renderer, context.format, context.registry.list()))
    })

  command
    .command("show")
    .description(`one chat from ${bot.name ?? "the messenger"}, and remember it`)
    .argument("<chat>", "a chat id, user:<id> for a person, or the title of a chat this bot has seen")
    .action(async function (this: Command, chat: string) {
      const context = online(botContext(this, bot), this)
      const ref = context.chatRef(chat)
      await context.run(async (events) => {
        const adapter = await context.authenticated({ events })
        const found = await botCan(adapter, "chat", bot, "describe a chat")(ref)
        context.registry.observe([found])
        await context.copy.keepChat(await botIdOf(context, adapter), found, context.renderer.warn)
        context.renderer.result(found)
      })
    })

  annotate(command.command("leave"), { mutates: true })
    .description("take the bot out of a chat; only an admin of the chat can bring it back")
    .argument("<chat>", "a chat id, or the title of a chat this bot has seen")
    .action(async function (this: Command, chat: string) {
      const context = online(botContext(this, bot), this)
      const ref = context.chatRef(chat)
      await context.run(async (events) => {
        const adapter = await context.authenticated({ events })
        const leave = botCan(adapter, "leave", bot, "leave a chat")
        const operationId = newOperationId()
        await guardedWrite(
          context.guard(),
          { operationId, chatId: ref, kind: "chat", action: "leave", key: "bot.chats.leave" },
          () => leave(ref),
        )
        context.renderer.result({ operationId, chatId: ref, left: true })
      })
    })

  annotate(command.command("action"), { mutates: true })
    .description("show what the bot is doing in a chat — typing, sending a photo — for a few seconds")
    .argument("<chat>", "a chat id, user:<id> for a person, or the title of a chat this bot has seen")
    .addArgument(new Argument("<action>", "what the chat sees").choices(BOT_ACTIONS))
    .action(async function (this: Command, chat: string, action: BotAction) {
      const context = online(botContext(this, bot), this)
      const ref = context.chatRef(chat)
      await context.run(async (events) => {
        const adapter = await context.authenticated({ events })
        const act = botCan(adapter, "action", bot, "show an action")
        const operationId = newOperationId()
        await guardedWrite(context.guard(), { operationId, chatId: ref, kind: "chat", key: "bot.chats.action" }, () =>
          act(ref, action),
        )
        context.renderer.result({ operationId, chatId: ref, action })
      })
    })
  command.addCommand(botAdminsCommand(bot))
  command.addCommand(botMembersCommand(bot))
  command.addCommand(botRulesCommand(bot))
  command.addCommand(botModerateCommand(bot))
  return command
}

/**
 * The `bot` group: a bot account through the messenger's official Bot API and a bot token. A CLI adds
 * the commands that are still its own with `addCommand`, on this group or on its `chats`.
 */
const withCopyReads = (messages: Command, bot: BotMessenger): Command => {
  addBotCopyReads(messages, bot)
  return messages
}

export const botCommand = (bot: BotMessenger): Command => {
  const tokenVariable = envName(bot.app, "BOT_TOKEN")
  const command = new Command("bot")
    .description(
      `a ${bot.name ?? "messenger"} bot, through the official Bot API and a bot token — not your personal account`,
    )
    .addCommand(authCommand(bot, tokenVariable))
    .addCommand(listCommand(bot, tokenVariable))
    .addCommand(chatsCommand(bot))
    .addCommand(withCopyReads(botMessagesCommand(bot), bot))
    .addCommand(botSearchCommand(bot))
    .addCommand(recipientsCommand(bot))
    .addCommand(sendsCommand(bot))
    .addCommand(botWatchCommand(bot))
    .addCommand(botCallbacksCommand(bot))
    .addCommand(botMenuCommand(bot))
    .addCommand(botWebhooksCommand(bot))
    .addCommand(botContactsCommand(bot))
  if (bot.identity) command.addCommand(meCommand(bot))
  if (bot.fetching) command.addCommand(botStoreCommand(bot, bot.fetching))
  return bot.mcp ? command.addCommand(botMcpCommand(bot)) : command
}
