import { existsSync, readFileSync } from "node:fs"
import { CliError, writeSecurely } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import type { Id, Message } from "../../domain/models.js"
import { CHECK_READS, describe, type Gathered, MAX_ACTIONS, type Moderator } from "../../moderation/check.js"
import { defaultRules, ModerationRules, moderationPathFor, RULE_KEYS } from "../../moderation/rules.js"
import { moderateWith, type SavedPoint } from "../../moderation/run.js"
import { guardedWrite } from "../../sends/guarded.js"
import { newOperationId } from "../../sends/send-id.js"
import { dateWindow } from "../../services/moment.js"
import { environmentOf } from "../context.js"
import { grantsAuthority, LOCAL_READ, LOCAL_WRITE, ownerOnlyOption, REMOTE_WRITE } from "../effects.js"
import { itemOf, renderAnswer, snakeKeys } from "../envelope.js"
import { answerOf } from "../messenger/ask.js"
import { type BotContext, botContext, online } from "./context.js"
import { botExamples } from "./examples.js"
import { botCan, botIdOf } from "./messages.js"
import type { BotAdapter, BotMessenger } from "./port.js"
import { botFiles } from "./registry.js"

const CHAT = "a group's id, or the title of a group this bot has seen"

/** The personal profile of the same name keeps its rules in this file too: one group's rules, whoever acts on them. */
const rulesOf = (context: BotContext, bot: BotMessenger) =>
  new ModerationRules(moderationPathFor(bot.app, context.profile, context.env))

const titleOf = (context: BotContext, chatId: Id) =>
  context.registry.list().find((one) => one.id === chatId)?.title ?? null

const shown = (context: BotContext, chatId: Id, rules: ModerationRules) => {
  const saved = rules.read(chatId)
  const title = titleOf(context, chatId)
  // `rules` keeps the keys `rules set` takes.
  return itemOf({
    chat_id: chatId,
    title,
    file: rules.path,
    saved: saved !== undefined,
    rules: saved ?? defaultRules(title),
  })
}

/** `bot chats rules show|set|unset`: kept on this machine, the chat named the bot's way. */
export const botRulesCommand = (bot: BotMessenger): Command => {
  const command = new Command("rules").description("a chat's moderation rules for this bot, kept on this machine")
  annotate(command.command("show"), { effects: LOCAL_READ, examples: botExamples(bot, "chats rules show Team") })
    .description("the chat's rules; the defaults, marked not saved, if it has none yet")
    .argument("<chat>", CHAT)
    .action(function (this: Command, chat: string) {
      const context = botContext(this, bot)
      renderAnswer(this, context, shown(context, context.chatRef(chat), rulesOf(context, bot)))
    })
  grantsAuthority(
    annotate(command.command("set"), {
      effects: LOCAL_WRITE,
      examples: botExamples(bot, "chats rules set Team links delete"),
    }),
  )
    .description(`change one rule — ${RULE_KEYS.join(", ")}`)
    .summary("change one moderation rule of a chat")
    .argument("<chat>", CHAT)
    .argument("<key>", "the rule")
    .argument("<value>", "its new value")
    .action(function (this: Command, chat: string, key: string, value: string) {
      const context = botContext(this, bot)
      if (key.startsWith("newAccount.")) {
        throw new CliError("validation_error", "a bot is not told how old an account is, so newAccount cannot work")
      }
      const chatId = context.chatRef(chat)
      const rules = rulesOf(context, bot)
      rules.set(chatId, titleOf(context, chatId), key, value)
      renderAnswer(this, context, shown(context, chatId, rules))
    })
  grantsAuthority(
    annotate(command.command("unset"), {
      effects: LOCAL_WRITE,
      examples: botExamples(bot, "chats rules unset Team links"),
    }),
  )
    .description("put one rule back to its default")
    .argument("<chat>", CHAT)
    .argument("<key>", "the rule")
    .action(function (this: Command, chat: string, key: string) {
      const context = botContext(this, bot)
      const chatId = context.chatRef(chat)
      const rules = rulesOf(context, bot)
      rules.unset(chatId, titleOf(context, chatId), key)
      renderAnswer(this, context, shown(context, chatId, rules))
    })
  return command
}

/** Beside the bot's other state, one file per bot: max-cli's `bots/checks/<profile>.json`. */
const savedPoint = (path: string): SavedPoint => {
  const all = (): Record<string, string> =>
    existsSync(path)
      ? ((JSON.parse(readFileSync(path, "utf8")) as { points?: Record<string, string> }).points ?? {})
      : {}
  return {
    read: (chatId) => all()[chatId],
    write: (chatId, at) => writeSecurely(path, `${JSON.stringify({ points: { ...all(), [chatId]: at } })}\n`, 0o600),
  }
}

const gatherer =
  (command: Command, context: BotContext, bot: BotMessenger, adapter: BotAdapter, botId: string, chatId: Id) =>
  async (since: number): Promise<Gathered> => {
    const notes: string[] = []
    const read = adapter.historySince
      ? await adapter.historySince(chatId, since, CHECK_READS)
      : await context.copy.read(async (store) => {
          const page = await store.messages.messages(context.copy.accountOf(botId), chatId, {
            limit: CHECK_READS,
            since: new Date(since).toISOString(),
          })
          return { messages: page.items, more: page.hasMore }
        })
    if (!adapter.historySince) {
      notes.push(
        `${bot.name ?? "the messenger"} gives a bot no history: judged from what \`${context.words} watch\` kept`,
      )
    }
    const messages = [...read.messages].sort(
      (a: Message, b: Message) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    )

    const admins = adapter.admins ? await adapter.admins(chatId) : null
    if (admins === null) notes.push("the group's admins are not known, so only the bot's own messages are exempt")

    const joined = bot.joinsSince?.(command, context.profile, chatId, since)
    if (!bot.joinsSince) notes.push("this messenger's bot keeps no joins, so only messages are judged")
    else if (joined === undefined)
      notes.push(`no joins kept for this bot — run \`${context.words} watch\` to have them judged`)

    return {
      messages,
      joined: joined ?? [],
      answerers: new Set((admins ?? []).map((admin) => admin.id)),
      service: new Set(),
      until: messages.at(-1)?.timestamp ?? null,
      more: read.more,
      notes,
    }
  }

/** Each action through the bot's guard under `bot.chats.moderate`: typing the command was the consent. */
const moderatorOf = (
  context: BotContext,
  bot: BotMessenger,
  adapter: BotAdapter,
  botId: string,
  ban: boolean,
): Moderator => ({
  deleteMessage: async (chatId, messageId) => {
    const remove = botCan(adapter, "delete", bot, "delete messages")
    await guardedWrite(
      context.guard(),
      { operationId: newOperationId(), chatId, kind: "delete", count: 1, key: "bot.chats.moderate" },
      () => remove(chatId, [messageId]),
    )
    await context.copy.forget(botId, chatId, [messageId], context.renderer.warn)
  },
  removePerson: async (chatId, personId) => {
    const remove = botCan(adapter, "removeMember", bot, "remove people from a group")
    await guardedWrite(
      context.guard(),
      {
        operationId: newOperationId(),
        chatId,
        kind: "chat",
        action: "members.remove",
        people: 1,
        key: "bot.chats.moderate",
      },
      () => remove(chatId, personId, { block: ban }),
    )
  },
})

const yes = (answer: string) => /^\s*y(es)?\s*$/i.test(answer)

/**
 * `bot chats moderate`: the personal `chats moderate`, done by the bot. Typing it is the consent for
 * what the rules name. A removal bans unless `--no-block`.
 */
export const botModerateCommand = (bot: BotMessenger): Command =>
  annotate(new Command("moderate"), {
    effects: REMOTE_WRITE,
    examples: botExamples(bot, "chats moderate Team --dry-run"),
  })
    .description("judge a group's new messages and joins by its rules, and act as they allow — as the bot")
    .summary("act on a group's new messages and joins by its rules, as the bot")
    .argument("<chat>", CHAT)
    .option("--since-time <time>", "judge what came after this ISO 8601 time, or 2h / 1d ago; the saved point stays")
    .option("--dry-run", "judge and plan; do nothing")
    .addOption(ownerOnlyOption("--allow-dangerous", "yes to every action whose level in the group's rules is ask"))
    .option("--no-block", "remove without banning; by default a removed person cannot come back by the link")
    .addOption(
      ownerOnlyOption("--max-actions <n>", `at most this many actions in one run; ${MAX_ACTIONS} if not given`),
    )
    .action(async function (this: Command, chat: string) {
      const context = online(botContext(this, bot), this)
      const options = this.opts<{
        sinceTime?: string
        dryRun?: boolean
        allowDangerous?: boolean
        block: boolean
        maxActions?: string
      }>()
      const maxActions = options.maxActions === undefined ? MAX_ACTIONS : Number(options.maxActions)
      if (!Number.isInteger(maxActions) || maxActions < 0) {
        throw new CliError("validation_error", `--max-actions takes a whole number — got ${String(options.maxActions)}`)
      }
      const chatId = context.chatRef(chat)
      // An in-process caller's answer counts under --json too: it is not a terminal that could wait for ever.
      const given = environmentOf(this).answer
      const ask = async (question: string) => (given ? await given(question) : await answerOf(this, question))
      const window = dateWindow(options.sinceTime === undefined ? {} : { sinceTime: options.sinceTime })
      await context.run(async (events) => {
        const adapter = await context.authenticated({ events })
        const botId = await botIdOf(context, adapter)
        const { rows, notes } = await moderateWith({
          chatId,
          title: titleOf(context, chatId),
          rules: rulesOf(context, bot),
          point: savedPoint(botFiles(bot.app, context.profile, context.env).checks),
          gather: gatherer(this, context, bot, adapter, botId, chatId),
          moderator: moderatorOf(context, bot, adapter, botId, options.block),
          command: bot.app.command,
          commandFor: (group, finding) =>
            finding.action === "delete"
              ? `${context.words} messages delete ${group} ${finding.messageId} --allow-dangerous`
              : `${context.words} chats members remove ${group} ${finding.personId}`,
          ...(window.since === undefined ? {} : { since: window.since }),
          dryRun: options.dryRun === true,
          allowDangerous: options.allowDangerous === true,
          maxActions,
          confirm: async (finding) => {
            const answer = await ask(`${describe(finding)}? [y/N] `)
            return answer === null ? undefined : yes(answer)
          },
        })
        if (context.format === "pretty")
          context.renderer.result(
            rows.map((row) => ({
              what: row.kind,
              who: row.personName ?? row.personId,
              rule: row.rule,
              action: row.action,
              outcome: row.outcome,
              ...(row.reason ? { why: row.reason } : {}),
            })),
          )
        else renderAnswer(this, context, itemOf({ chat_id: chatId, rows: snakeKeys(rows) }, { meta: window.meta }))
        for (const note of notes) context.renderer.note(note)
      })
    })
