import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { guardedWrite } from "../../sends/guarded.js"
import { newOperationId } from "../../sends/send-id.js"
import { REMOTE_READ, REMOTE_WRITE } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { listQuery, typedQuery, withQuery } from "../list-query.js"
import { wholeList } from "../messenger/chat-answers.js"
import { type BotContext, botContext, online } from "./context.js"
import { botExamples } from "./examples.js"
import { BOT_MENU_QUERY, BOT_WEBHOOKS_QUERY } from "./list-queries.js"
import { botCan } from "./messages.js"
import type { BotMenuEntry, BotMessenger } from "./port.js"
import { botFiles } from "./registry.js"
import { PressLog } from "./updates.js"

const entryOf = (typed: string): BotMenuEntry => {
  const split = typed.indexOf("=")
  const name = (split === -1 ? typed : typed.slice(0, split)).replace(/^\//, "").trim()
  if (!name) throw new CliError("validation_error", `a command is name=description, not ${typed}`)
  const description = split === -1 ? "" : typed.slice(split + 1).trim()
  return { name, description: description || null }
}

const typesOf = (typed: string | undefined): string[] | undefined => {
  const types = typed
    ?.split(",")
    .map((one) => one.trim())
    .filter(Boolean)
  return types && types.length > 0 ? types : undefined
}

/** A change to the bot itself, not to a chat: guarded and journaled with no chat. */
const botWrite = (context: BotContext, key: string, write: () => Promise<void>) =>
  guardedWrite(context.guard(), { operationId: newOperationId(), chatId: null, kind: "account", key }, write)

/** `bot commands`: the menu people see when they type `/`. */
export const botMenuCommand = (bot: BotMessenger): Command => {
  const command = new Command("commands").description("the bot's command menu — what people see after /")

  withQuery(
    annotate(command.command("list"), { effects: REMOTE_READ, examples: botExamples(bot, "commands list") }),
    BOT_MENU_QUERY,
  )
    .description("the commands in the menu now")
    .action(async function (this: Command, words: string[]) {
      listQuery(typedQuery(words), BOT_MENU_QUERY, "bot commands list")
      const context = online(botContext(this, bot), this)
      await context.run(async (events) => {
        const adapter = await context.authenticated({ events })
        renderAnswer(
          this,
          context,
          wholeList("bot commands list", await botCan(adapter, "menu", bot, "read its menu")()),
        )
      })
    })

  const replace = async (command: Command, entries: BotMenuEntry[], key: string) => {
    const context = online(botContext(command, bot), command)
    await context.run(async (events) => {
      const adapter = await context.authenticated({ events })
      const set = botCan(adapter, "setMenu", bot, "change its menu")
      await botWrite(context, key, () => set(entries))
      renderAnswer(command, context, wholeList("bot commands list", entries))
    })
  }

  annotate(command.command("set"), {
    effects: REMOTE_WRITE,
    examples: botExamples(bot, 'commands set "start=Begin here" "help=What I can do"'),
  })
    .description("replace the whole menu: each command as name=description, e.g. start=Begin")
    .argument("<commands...>", "name=description, one per command")
    .action(async function (this: Command, typed: string[]) {
      await replace(this, typed.map(entryOf), "bot.commands.set")
    })

  annotate(command.command("clear"), {
    effects: REMOTE_WRITE,
    examples: botExamples(bot, "commands clear"),
  })
    .description("empty the menu")
    .action(async function (this: Command) {
      await replace(this, [], "bot.commands.clear")
    })

  return command
}

/** `bot callbacks`: answers to the buttons people press under the bot's messages. */
export const botCallbacksCommand = (bot: BotMessenger): Command =>
  new Command("callbacks").description("answers to the buttons people press under the bot's messages").addCommand(
    annotate(new Command("answer"), {
      effects: REMOTE_WRITE,
      examples: botExamples(bot, 'callbacks answer 4385 --notification "Saved"'),
    })
      .description(
        "answer a pressed button by its callback id: --notification shows the person a one-time note, " +
          "--text replaces the message the button was on",
      )
      .summary("answer a pressed button: a note to that person, or new message text")
      .argument("<callback>", "the callback id `bot watch` printed")
      .option("--text <text>", "the message's new text")
      .option("--notification <text>", "a note only the person who pressed sees")
      .action(async function (this: Command, callbackId: string) {
        const context = online(botContext(this, bot), this)
        const { text, notification } = this.opts<{ text?: string; notification?: string }>()
        if (text === undefined && notification === undefined) {
          throw new CliError("validation_error", "an answer needs --text, --notification, or both")
        }
        const press =
          text === undefined
            ? undefined
            : new PressLog(botFiles(bot.app, context.profile, context.env).presses).find(callbackId)
        await context.run(async (events) => {
          const adapter = await context.authenticated({ events })
          const answer = botCan(adapter, "answer", bot, "answer a button")
          const operationId = newOperationId()
          await guardedWrite(
            context.guard(),
            {
              operationId,
              chatId: press?.chatId ?? null,
              kind: "message",
              key: "bot.callbacks.answer",
              ...(text === undefined ? {} : { length: text.length }),
            },
            () =>
              answer(callbackId, {
                ...(text === undefined ? {} : { text }),
                ...(notification === undefined ? {} : { notification }),
                ...(press ? { press } : {}),
              }),
          )
          renderAnswer(this, context, itemOf({ operation_id: operationId, callback_id: callbackId, answered: true }))
        })
      }),
  )

/** `bot webhooks`: where the messenger pushes this bot's updates instead of being polled. */
export const botWebhooksCommand = (bot: BotMessenger): Command => {
  const command = new Command("webhooks")
    .description("where the messenger pushes this bot's updates — while one is set, `bot watch` gets nothing")
    .summary("where the messenger pushes this bot's updates")

  withQuery(
    annotate(command.command("list"), { effects: REMOTE_READ, examples: botExamples(bot, "webhooks list") }),
    BOT_WEBHOOKS_QUERY,
  )
    .description("the webhooks this bot has")
    .action(async function (this: Command, words: string[]) {
      listQuery(typedQuery(words), BOT_WEBHOOKS_QUERY, "bot webhooks list")
      const context = online(botContext(this, bot), this)
      await context.run(async (events) => {
        const adapter = await context.authenticated({ events })
        renderAnswer(
          this,
          context,
          wholeList(
            "bot webhooks list",
            (await botCan(adapter, "webhooks", bot, "list its webhooks")()).map(snakeKeys),
          ),
        )
      })
    })

  const set = annotate(command.command("set"), {
    effects: REMOTE_WRITE,
    examples: botExamples(bot, "webhooks set https://bot.example.ts.net/"),
  })
    .description("send this bot's updates to an HTTPS address; refused while another is set")
    .argument("<url>", "the HTTPS address")
    .option("--types <types>", "only these update types, comma-separated, in the messenger's words")
    .option("--secret-stdin", "a secret the messenger sends back with each update — asked for, or read from a pipe")
  if (bot.manyWebhooks) set.option("--add", "keep the webhooks already set and add this one beside them")
  set.action(async function (this: Command, url: string) {
    const context = online(botContext(this, bot), this)
    const options = this.opts<{ types?: string; secretStdin?: boolean; add?: boolean }>()
    await context.run(async (events) => {
      const adapter = await context.authenticated({ events })
      const list = botCan(adapter, "webhooks", bot, "list its webhooks")
      const others = (await list()).filter((one) => one.url !== url)
      if (others.length > 0 && !options.add) {
        throw new CliError(
          "confirmation_required",
          `this bot already sends its updates to ${others.map((one) => one.url).join(", ")} — ` +
            `remove it first with \`${context.words} webhooks delete <url>\`` +
            (bot.manyWebhooks ? ", or give --add to get every update at both" : ""),
        )
      }
      const types = typesOf(options.types)
      const setWebhook = botCan(adapter, "setWebhook", bot, "set a webhook")
      // The secret is asked for only once the profile may set a webhook at all.
      await botWrite(context, "bot.webhooks.set", async () => {
        const secret = options.secretStdin ? (await context.readSecret("Webhook secret: ")).trim() : undefined
        if (options.secretStdin && !secret) throw new CliError("validation_error", "no secret given")
        await setWebhook(url, { ...(types ? { types } : {}), ...(secret ? { secret } : {}) })
      })
      renderAnswer(this, context, wholeList("bot webhooks list", (await list()).map(snakeKeys)))
    })
  })

  annotate(command.command("delete"), {
    effects: REMOTE_WRITE,
    examples: botExamples(bot, "webhooks delete https://bot.example.ts.net/"),
  })
    .description("stop sending updates to this address; with none left, `bot watch` works again")
    .argument("<url>", "the address")
    .action(async function (this: Command, url: string) {
      const context = online(botContext(this, bot), this)
      await context.run(async (events) => {
        const adapter = await context.authenticated({ events })
        const remove = botCan(adapter, "deleteWebhook", bot, "delete a webhook")
        await botWrite(context, "bot.webhooks.delete", () => remove(url))
        renderAnswer(
          this,
          context,
          wholeList(
            "bot webhooks list",
            (await botCan(adapter, "webhooks", bot, "list its webhooks")()).map(snakeKeys),
          ),
        )
      })
    })

  return command
}
