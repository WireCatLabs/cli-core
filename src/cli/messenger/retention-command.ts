import { annotate } from "@wirecat/cli-base/commands"
import { Command, Option } from "commander"
import { renderAnswer } from "../envelope.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"
import { retentionAnswer } from "./stats-answers.js"

export const retentionCommand = (messenger: Messenger) =>
  annotate(new Command("retention"), { output: { entity: "retention" } })
    .description("joining cohorts and observed checkpoint membership from saved roster observations")
    .argument("<chat>", messenger.chatArgument)
    .option("--since-time <time>", "joining period starts at ISO 8601 or a relative time; last 90 days by default")
    .option("--until-time <time>", "joining period ends at this time; now by default")
    .option("--checkpoints <durations>", "up to 10 increasing joining ages, comma separated; 1d,7d,30d by default")
    .option("--within <duration>", "activity and early departure window after joining; 7d by default")
    .addOption(
      new Option("--by <day|week>", "group joining dates by calendar day or Monday week").choices(["day", "week"]),
    )
    .option("--timezone <zone>", "IANA timezone for joining cohorts")
    .option("--limit <n>", "cohorts and member evidence, 1–100", positiveCount("--limit"))
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) => services.retention.report(chat, this.opts()))
      renderAnswer(this, context, retentionAnswer(found), () =>
        found.items
          .map(
            (row) =>
              `${row.cohort}: ${row.stays} stays; ${row.checkpoints.map((point) => `${point.ageMilliseconds / 86_400_000}d ${point.present}/${point.observable} observed, ${point.unknown} unknown, ${point.pending} pending`).join("; ")}\n`,
          )
          .join(""),
      )
    })
