import { Command } from "commander"
import type { AdminReport } from "../../domain/admin-statistics.js"
import type { AdminQuery } from "../../services/admin-statistics.js"
import { environmentOf } from "../context.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"

const collect = (value: string, previous: string[] = []) => [...previous, value]
export const adminStatisticsCommand = (messenger: Messenger, report: AdminReport): Command => {
  const descriptions = {
    unanswered: "oldest detected questions without an observed qualifying explicit reply",
    responses: "counts and median/p90 latency for selected human answering identities",
    newcomers: "known-join members and their help within a join window",
    discussion: "viewed posts with little recorded discussion",
  }
  const command = new Command(report).description(descriptions[report])
  if (report === "newcomers")
    command
      .argument("<chat>", messenger.chatArgument)
      .option("--since-time <time>", "from this ISO 8601 time, or 2h / 1d ago; 30d ago if not given")
      .option("--until-time <time>", "through this ISO 8601 time, or 2h / 1d ago")
      .option("--within <duration>", "the help window after a known newcomer join")
  else
    command
      .argument("[query...]", "a strict Lucene query; none selects every stored message")
      .option("--chat <chat>", `only this chat; ${messenger.chatArgument}`)
      .option("--source <accounts>", "every held account of this messenger; personal, bots or all")
      .option("--exact", "bare words match exact forms rather than stems")
  command.option("--saved <name|id>", "run a saved report of this kind; typed report options replace stored options")
  command
    .option("--timezone <zone>", "the IANA timezone for calendar date boundaries")
    .option("--limit <n>", "report rows, 1–100; 20 if not given", positiveCount("--limit"))
  if (report !== "discussion")
    command.option(
      "--answerer <person>",
      "stored name, alias, @username, ID or person:provider/account/id; ambiguous names require a choice; repeat for more",
      collect,
    )
  if (report === "unanswered")
    command.option("--older-than <duration>", "minimum age of a question without an observed qualifying answer")
  if (report === "discussion")
    command
      .option("--min-views <n>", "minimum known cumulative views", Number)
      .option("--max-replies <n>", "maximum observed discussion replies", Number)
  command.action(async function (this: Command, argument: string | string[]) {
    const context = messengerContext(this, messenger)
    const { answerer, ...options } = this.opts<Omit<AdminQuery, "answerers"> & { answerer?: string[] }>()
    const found = await context.withServices((services) =>
      services.adminStatistics.report(report, {
        ...options,
        limit: options.limit ?? 20,
        ...(answerer ? { answerers: answerer } : {}),
        ...(report === "newcomers"
          ? { chat: argument as string }
          : (argument as string[]).length
            ? { text: (argument as string[]).join(" ") }
            : {}),
        signal: environmentOf(this).commandSignal ?? environmentOf(this).signal,
      }),
    )
    if (context.format === "jsonl")
      context.renderer.stream(
        found.items.map((item) => ({ ...item, report: found.report, cutoff: found.cutoff, quality: found.quality })),
      )
    else context.renderer.result(found)
  })
  return command
}
