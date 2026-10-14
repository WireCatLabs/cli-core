import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { describe, MAX_ACTIONS } from "../../moderation/check.js"
import { RULE_KEYS } from "../../moderation/rules.js"
import { momentOf } from "../../services/moment.js"
import { itemOf, renderAnswer } from "../envelope.js"
import { answerOf } from "./ask.js"
import { renderItem, snakeKeys } from "./chat-answers.js"
import { type Messenger, messengerContext } from "./context.js"

/** `chats rules show|set|unset`: the rules live in a file of this profile, and only the chat's id is asked of the messenger. */
export const rulesCommand = (messenger: Messenger): Command => {
  const rules = new Command("rules").description(
    "what `chats moderate` judges a group by, kept in a file of this profile",
  )
  rules
    .command("show")
    .description("the group's rules; the defaults, marked not saved, if it has none yet")
    .argument("<chat>", messenger.chatArgument)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      renderItem(this, context, await context.withServices((services) => services.moderation.rules(chat)))
    })
  rules.addCommand(
    annotate(new Command("set"), { mutates: true, local: true })
      .description("change one rule; the group's first change writes every rule with its default")
      .argument("<chat>", messenger.chatArgument)
      .argument("<key>", `one of: ${RULE_KEYS.join(", ")}`)
      .argument("<value>", "the new value; a list is comma-separated")
      .action(async function (this: Command, chat: string, key: string, value: string) {
        const context = messengerContext(this, messenger)
        renderItem(this, context, await context.withServices((services) => services.moderation.set(chat, key, value)))
      }),
  )
  rules.addCommand(
    annotate(new Command("unset"), { mutates: true, local: true })
      .description("put one rule back to its default")
      .argument("<chat>", messenger.chatArgument)
      .argument("<key>", `one of: ${RULE_KEYS.join(", ")}`)
      .action(async function (this: Command, chat: string, key: string) {
        const context = messengerContext(this, messenger)
        renderItem(this, context, await context.withServices((services) => services.moderation.unset(chat, key)))
      }),
  )
  return rules
}

/**
 * **The one command that acts on a group's rules** (max-cli `NEED-306`): typing it is the consent
 * for what the rules name, within each action's level in the group's rules. Nothing watches groups
 * in the background.
 */
export const moderateCommand = (messenger: Messenger): Command =>
  annotate(new Command("moderate"), { mutates: true })
    .description("judge a group's new messages and members by its rules, and act as they allow")
    .argument("<chat>", messenger.chatArgument)
    .option("--since-time <time>", "judge what came after this ISO 8601 time, or 2h / 1d ago; the saved point stays")
    .option("--dry-run", "judge and plan; do nothing")
    .option("--allow-dangerous", "yes to every action whose level in the group's rules is ask")
    .option("--max-actions <n>", `at most this many actions in one run; ${MAX_ACTIONS} if not given`)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const options = this.opts<{
        sinceTime?: string
        dryRun?: boolean
        allowDangerous?: boolean
        maxActions?: string
      }>()
      const maxActions = options.maxActions === undefined ? MAX_ACTIONS : Number(options.maxActions)
      if (!Number.isInteger(maxActions) || maxActions < 0) {
        throw new CliError("validation_error", `--max-actions takes a whole number — got ${String(options.maxActions)}`)
      }
      const { chatId, rows, notes } = await context.withServices((services) =>
        services.moderation.moderate(chat, {
          ...(options.sinceTime === undefined ? {} : { since: momentOf(options.sinceTime, "--since-time") }),
          dryRun: options.dryRun === true,
          allowDangerous: options.allowDangerous === true,
          maxActions,
          confirm: async (finding) => {
            const answer = await answerOf(this, `${describe(finding)}? [y/N] `)
            if (answer === null) return undefined
            return /^\s*y(es)?\s*$/i.test(answer)
          },
        }),
      )
      renderAnswer(this, context, itemOf(snakeKeys({ chatId, rows })), () =>
        rows
          .map((row) =>
            [row.kind, row.personName ?? row.personId, row.rule, row.action, row.outcome, row.reason ?? ""]
              .join("  ")
              .trimEnd(),
          )
          .map((line) => `${line}\n`)
          .join(""),
      )
      for (const note of notes) context.renderer.note(note)
    })
