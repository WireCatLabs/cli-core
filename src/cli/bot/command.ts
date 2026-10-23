import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Argument, Command } from "commander"
import { envName } from "../../ports/app.js"
import { guardedWrite } from "../../sends/guarded.js"
import { newOperationId } from "../../sends/send-id.js"
import { grantsAuthority, LOCAL_READ, LOCAL_WRITE, REMOTE_READ, REMOTE_WRITE } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { renderItem, wholeList } from "../messenger/chat-answers.js"
import { botAdminsCommand, botMembersCommand } from "./admins.js"
import { botContext, online } from "./context.js"
import { botExamples } from "./examples.js"
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

/** Where each of the messenger's other secrets comes from, `null` when it is not set; never the value. */
const secretSources = (bot: BotMessenger, tokens: BotTokenStore) =>
  bot.secrets?.length
    ? { secrets: Object.fromEntries(bot.secrets.map((one) => [one.name, tokens.readSecret(one.name)?.source ?? null])) }
    : {}

const authCommand = (bot: BotMessenger, tokenVariable: string): Command => {
  const auth = annotate(new Command("auth"), { mcp: false }).description("the bot token this profile uses")

  const set = grantsAuthority(
    annotate(auth.command("set"), { effects: LOCAL_WRITE, examples: botExamples(bot, "auth set") }),
  )
    .description(
      `check a bot token with ${bot.name ?? "the messenger"}, then keep it — typed at a hidden prompt or piped on stdin`,
    )
    .summary("check a bot token, then keep it; or keep a named secret beside it")
  const secrets = bot.secrets ?? []
  if (secrets.length > 0)
    set.option(
      "--secret <name>",
      `keep this secret instead of the token, the same way: ${secrets.map((one) => `${one.name} (${one.description})`).join("; ")}`,
    )
  set.action(async function (this: Command) {
    const { secret: named } = this.opts<{ secret?: string }>()
    if (named !== undefined) {
      const secret = secrets.find((one) => one.name === named)
      if (!secret)
        throw new CliError(
          "validation_error",
          `no secret called "${named}" — one of: ${secrets.map((one) => one.name).join(", ")}`,
        )
      const context = botContext(this, bot)
      await context.run(async () => {
        const value = (await context.readSecret(`${secret.description}: `)).trim()
        if (!value) throw new CliError("validation_error", "no secret given")
        renderItem(this, context, {
          profile: context.profile,
          secret: secret.name,
          stored: context.tokens.writeSecret(secret.name, value),
        })
      })
      return
    }
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
      renderItem(this, context, {
        profile: context.profile,
        stored,
        bot: account.name,
        id: account.id,
        username: account.username,
      })
    })
  })

  annotate(auth.command("show"), { effects: LOCAL_READ, examples: botExamples(bot, "auth show") })
    .description("where this profile's bot token comes from, and which bot it is")
    .action(async function (this: Command) {
      const context = online(botContext(this, bot), this)
      await context.run(async (events) => {
        const source = context.tokens.read()?.source
        const account = await (await context.authenticated({ events })).me()
        renderItem(this, context, {
          profile: context.profile,
          source,
          bot: account.name,
          id: account.id,
          username: account.username,
          ...secretSources(bot, context.tokens),
        })
      })
    })

  grantsAuthority(annotate(auth.command("remove"), { effects: LOCAL_WRITE, examples: botExamples(bot, "auth remove") }))
    .description("forget this profile's bot token")
    .action(async function (this: Command) {
      const context = botContext(this, bot)
      await context.run(async () => {
        const removed = context.tokens.remove()
        const secrets = Object.fromEntries(
          (bot.secrets ?? []).map((one) => [one.name, context.tokens.removeSecret(one.name)]),
        )
        renderAnswer(
          this,
          context,
          itemOf({ profile: context.profile, removed, ...(bot.secrets?.length ? { secrets } : {}) }),
        )
      })
    })

  return auth
}

const meCommand = (bot: BotMessenger): Command =>
  annotate(new Command("me"), { effects: REMOTE_READ, examples: botExamples(bot, "me") })
    .description("the bot this profile's token belongs to: id, name and username")
    .action(async function (this: Command) {
      const context = online(botContext(this, bot), this)
      await context.run(async (events) => {
        const adapter = await context.authenticated({ events })
        try {
          renderItem(this, context, await adapter.me())
        } finally {
          await adapter.close()
        }
      })
    })

const listCommand = (bot: BotMessenger, tokenVariable: string): Command =>
  annotate(new Command("list"), { effects: LOCAL_READ, examples: botExamples(bot, "list", "list --check") })
    .description(
      `every name on this machine that has a bot token; --check asks ${bot.name ?? "the messenger"} which bot each is`,
    )
    .summary("every bot profile on this machine; --check asks which bot each is")
    .option("--check", "ask the messenger who each bot is, with its token")
    .action(async function (this: Command) {
      const context = botContext(this, bot)
      const check = this.opts<{ check?: boolean }>().check === true
      if (check) online(context, this)
      await context.run(async (events) => {
        const names = [
          ...new Set([...context.settings.configuredProfiles, ...registryProfiles(bot.app, context.env)]),
        ].sort()
        if (context.env[tokenVariable]) {
          context.streams.diagnostic(`${tokenVariable} is set, so every name uses that one token`)
        }
        const rows = []
        for (const name of names) {
          const tokens =
            bot.tokenStore?.(this, name) ??
            new BotTokenStore({
              app: bot.app,
              profile: name,
              env: context.env,
              ...(context.keyring ? { keyring: context.keyring } : {}),
            })
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
        renderAnswer(this, context, wholeList("bot list", rows))
      })
    })

const recipientsCommand = (bot: BotMessenger): Command => {
  const command = new Command("recipients")
    .description("the chats this bot may write to; with no list, every chat — `clear` removes the list")
    .summary("the chats this bot may write to; with no list, every chat")
  annotate(command.command("list"), { effects: LOCAL_READ, examples: botExamples(bot, "recipients list") })
    .description("the chats on the list, or nothing when there is no list")
    .action(async function (this: Command) {
      const context = botContext(this, bot)
      await context.run(async () =>
        renderAnswer(
          this,
          context,
          wholeList("bot recipients list", (context.recipients().read() ?? []).map(snakeKeys)),
        ),
      )
    })
  grantsAuthority(
    annotate(command.command("add"), {
      effects: LOCAL_WRITE,
      examples: botExamples(bot, "recipients add Team"),
    }),
  )
    .argument("<chat>", "a chat id, `user:<id>`, or the title of a chat this bot has seen")
    .description("allow a chat: its id, `user:<id>`, or the title of a chat this bot has seen")
    .action(async function (this: Command, chat: string) {
      const context = botContext(this, bot)
      await context.run(async () => {
        const id = context.chatRef(chat)
        const title = context.registry.list().find((seen) => seen.id === id)?.title ?? null
        context.recipients().add({ id, title, addedAt: new Date().toISOString() })
        renderAnswer(
          this,
          context,
          wholeList("bot recipients list", (context.recipients().read() ?? []).map(snakeKeys)),
        )
      })
    })
  grantsAuthority(
    annotate(command.command("remove"), {
      effects: LOCAL_WRITE,
      examples: botExamples(bot, "recipients remove Team"),
    }),
  )
    .argument("<chat>", "the chat id, or the title as the list shows it")
    .description("take a chat off the list")
    .action(async function (this: Command, chat: string) {
      const context = botContext(this, bot)
      await context.run(async () => renderItem(this, context, { removed: context.recipients().remove(chat) ?? null }))
    })
  grantsAuthority(
    annotate(command.command("clear"), { effects: LOCAL_WRITE, examples: botExamples(bot, "recipients clear") }),
  )
    .description("remove the list: the bot may write to any chat again")
    .action(async function (this: Command) {
      const context = botContext(this, bot)
      await context.run(async () => renderAnswer(this, context, itemOf({ removed: context.recipients().off() })))
    })
  return command
}

const sendsCommand = (bot: BotMessenger): Command =>
  new Command("sends")
    .description("what this bot sent, edited and deleted from this machine — ids and outcomes, never text")
    .summary("what this bot sent, edited and deleted from here — never the text")
    .addCommand(
      annotate(new Command("list"), { effects: LOCAL_READ, examples: botExamples(bot, "sends list") })
        .description("every send, edit and delete this bot made from this machine, with its outcome")
        .action(async function (this: Command) {
          const context = botContext(this, bot)
          await context.run(async () =>
            renderAnswer(this, context, wholeList("bot sends list", context.journal().entries().map(snakeKeys))),
          )
        }),
    )

const chatsCommand = (bot: BotMessenger): Command => {
  const command = new Command("chats")
    .description(
      `the chats this bot is in — ${bot.name ?? "the messenger"} gives a bot no list of them, so \`list\` shows the ones it has seen`,
    )
    .summary("the chats this bot is in, and what it does there")
  annotate(command.command("list"), { effects: REMOTE_READ, examples: botExamples(bot, "chats list") })
    .description(`chats this bot has seen on this machine — not a complete list from ${bot.name ?? "the messenger"}`)
    .action(async function (this: Command) {
      const context = botContext(this, bot)
      await context.run(async () =>
        renderAnswer(this, context, wholeList("bot chats list", context.registry.list().map(snakeKeys))),
      )
    })

  annotate(command.command("show"), { effects: REMOTE_READ, examples: botExamples(bot, "chats show Team") })
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
        renderItem(this, context, found)
      })
    })

  annotate(command.command("leave"), {
    effects: REMOTE_WRITE,
    examples: botExamples(bot, "chats leave Team"),
  })
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
        renderAnswer(this, context, itemOf({ operation_id: operationId, chat_id: ref, left: true }))
      })
    })

  annotate(command.command("action"), { effects: REMOTE_WRITE, examples: botExamples(bot, "chats action Team typing") })
    .description("show what the bot is doing in a chat — typing, sending a photo — for a few seconds")
    .summary("show what the bot is doing in a chat, for a few seconds")
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
        renderAnswer(this, context, itemOf({ operation_id: operationId, chat_id: ref, action }))
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
    .summary("a bot account, through the official Bot API and a bot token")
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
