import { annotate } from "@wirecat/cli-base/commands"
import { Command, Option } from "commander"
import type { ReplyWho } from "../../services/reply-stats.js"
import { LOCAL_READ } from "../effects.js"
import { renderAnswer } from "../envelope.js"
import { type Messenger, messengerContext } from "./context.js"
import { refuseJsonl, responsesAnswer, waitingAnswer } from "./stats-answers.js"

const QUERY = "date:, chat: and kind: terms, AND-ed — date>=30d, date:[60d TO 30d]; none reads all time"
const GUIDE =
  "Guide: https://github.com/WireCatLabs/cli-core/blob/main/docs/rankings.md#reply-times-and-chats-waiting-on-you"

const minutes = (ms: number | null) => (ms === null ? "—" : `${Math.round(ms / 60_000)} min`)

export const replyResponsesCommand = (messenger: Messenger): Command =>
  annotate(new Command("responses"), { effects: LOCAL_READ, output: { entity: "response_times" } })
    .summary("how fast replies come in one-to-one chats: median, p90, mean and buckets")
    .description(
      "how long the owner took to answer (--who me), or the other side took to answer the owner (--who others), in " +
        "one-to-one chats — the local store only. Several messages in a row followed by one answer count as one " +
        "reply, timed from the first unanswered message; the day of a row is the day of the reply",
    )
    .argument("[query...]", QUERY)
    .addOption(new Option("--who <side>", "whose replies: the owner's or the other side's").choices(["me", "others"]))
    .addOption(new Option("--by <group>", "one row per calendar day of the reply, or none").choices(["day", "total"]))
    .option("--timezone <zone>", "the IANA timezone for calendar days and date: bounds")
    .option("--source <accounts>", "every account of this messenger held in the store; personal, bots or all")
    .addHelpText("after", GUIDE)
    .action(async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger)
      refuseJsonl(context.format)
      const { who, by, timezone, source } = this.opts<{
        who?: ReplyWho
        by?: "day" | "total"
        timezone?: string
        source?: string
      }>()
      const found = await context.withServices((services) =>
        services.replyStats.responses({
          who: who ?? "me",
          by: by ?? "total",
          ...(words.length ? { text: words.join(" ") } : {}),
          ...(timezone === undefined ? {} : { timezone }),
          ...(source === undefined ? {} : { source }),
        }),
      )
      renderAnswer(this, context, responsesAnswer(found), () =>
        [
          `${found.replies} replies · median ${minutes(found.medianMs)} · p90 ${minutes(found.p90Ms)} · mean ${minutes(found.meanMs)}`,
          ...found.rows.map((row) => `${row.key}  ${row.replies} replies · median ${minutes(row.medianMs)}`),
          "",
        ].join("\n"),
      )
    })

export const replyWaitingCommand = (messenger: Messenger): Command =>
  annotate(new Command("waiting"), { effects: LOCAL_READ, output: { entity: "waiting_chats" } })
    .summary("chats whose newest message asks the owner something")
    .description(
      "how many chats wait on the owner — the local store only: a one-to-one chat whose newest message is a " +
        "question, or a group whose newest message mentions the owner or replies to them. Muted or archived " +
        "one-to-one chats are left out, as inbox leaves them out; date: bounds the newest message's time",
    )
    .argument("[query...]", QUERY)
    .option("--timezone <zone>", "the IANA timezone for date: bounds")
    .option("--source <accounts>", "every account of this messenger held in the store; personal, bots or all")
    .addHelpText("after", GUIDE)
    .action(async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger)
      refuseJsonl(context.format)
      const { timezone, source } = this.opts<{ timezone?: string; source?: string }>()
      const found = await context.withServices((services) =>
        services.replyStats.waiting({
          ...(words.length ? { text: words.join(" ") } : {}),
          ...(timezone === undefined ? {} : { timezone }),
          ...(source === undefined ? {} : { source }),
        }),
      )
      renderAnswer(
        this,
        context,
        waitingAnswer(found),
        () =>
          `${found.chats} chats wait on you (${found.byKind.private} one-to-one, ${found.byKind.group} groups) · ${found.messages} messages${found.oldestAt ? ` · oldest ${found.oldestAt}` : ""}\n`,
      )
    })
