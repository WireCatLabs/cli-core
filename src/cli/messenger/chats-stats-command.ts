import { CliError } from "@wirecat/cli-base"
import { Command } from "commander"
import type { StatsPeriod } from "../../services/chat-stats.js"
import { EVENTS_DAYS } from "../../services/chats.js"
import { momentOf } from "../../services/moment.js"
import { type Messenger, messengerContext } from "./context.js"

const PERIODS: StatsPeriod[] = ["day", "week"]

export const statsCommand = (messenger: Messenger): Command =>
  new Command("show")
    .description(
      "a group's or channel's numbers for a period: messages, active members, replies, reactions, questions answered, " +
        "joins and leaves — counted from the local store; joins and leaves are asked of the messenger",
    )
    .argument("<chat>", messenger.chatArgument)
    .option("--since-time <time>", `ISO 8601, or 2h / 1d ago; ${EVENTS_DAYS} days ago if not given`)
    .option("--by <day|week>", "also one row per calendar day or week (weeks start on Monday)", periodOf)
    .option("--timezone <zone>", "the IANA timezone for calendar days")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const { sinceTime, by, timezone } = this.opts<{ sinceTime?: string; by?: StatsPeriod; timezone?: string }>()
      const stats = await context.withServices((services) =>
        services.chats.stats(chat, {
          ...(sinceTime === undefined ? {} : { since: momentOf(sinceTime, "--since-time") }),
          ...(by ? { by } : {}),
          ...(timezone === undefined ? {} : { timezone }),
        }),
      )
      if (!stats.complete) {
        context.renderer.note(
          stats.completeness.state === "complete"
            ? "the messenger stopped reading joins and leaves before the period's start — those are lower bounds"
            : `the store does not hold this chat whole, so these are lower bounds — \`${stats.fetch}\` fetches it`,
        )
      }
      if (!stats.members) context.renderer.note("joins and leaves were not asked of the messenger")
      if (context.format !== "pretty") {
        context.renderer.result(stats)
        return
      }
      const { questions, members } = stats
      const lines = [
        `${stats.since} – ${stats.until}`,
        `messages ${stats.messages}, from ${stats.senders} people; replies ${stats.replies}, threads ${stats.threads}`,
        `reactions ${stats.reactions}${stats.views === undefined ? "" : `, views ${stats.views}`}${
          stats.forwards === undefined ? "" : `, forwards ${stats.forwards}`
        }${stats.comments === undefined ? "" : `, comments ${stats.comments}`}`,
        `questions ${questions.asked}, answered ${questions.answered}${minutes(questions.medianMinutesToAnswer, "answer")}`,
        ...(members
          ? [
              `joined ${members.joined}, left ${members.left}, net ${members.net}; ${members.wrote} of those who joined wrote${minutes(
                members.medianMinutesToFirstMessage,
                "first message",
              )}`,
            ]
          : []),
        ...(stats.series ?? []).map(({ key, messages, senders, joined, left }) =>
          [
            key,
            `${messages} messages`,
            `${senders} people`,
            ...(joined === undefined ? [] : [`+${joined} −${left}`]),
          ].join("  "),
        ),
      ]
      context.streams.data(lines.join("\n"))
    })

const minutes = (value: number | null, what: string) => (value === null ? "" : `; median ${value} min to ${what}`)

const periodOf = (value: string): StatsPeriod => {
  if (!(PERIODS as string[]).includes(value)) throw new CliError("validation_error", `--by takes ${PERIODS.join(", ")}`)
  return value as StatsPeriod
}
