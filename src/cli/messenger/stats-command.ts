import { writeFileSync } from "node:fs"
import { extname, resolve } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { timezoneOf } from "@wirecat/cli-base/query"
import { Command } from "commander"
import { chartKindOf, chartPeriodOf, chatChart } from "../../charts/chat.js"
import { CHART_SIZE, type ChartKind, type ChartPeriod } from "../../charts/model.js"
import { chartPng } from "../../charts/png.js"
import { chartRenderer } from "../../charts/render.js"
import { EVENTS_DAYS } from "../../services/chats.js"
import { dateWindow } from "../../services/moment.js"
import { destroysNothing, LOCAL_WRITE } from "../effects.js"
import { renderAnswer } from "../envelope.js"
import { commandAt } from "../steps.js"
import { adminStatisticsCommand } from "./admin-statistics-command.js"
import { statsCommand as chatStatsCommand } from "./chats-stats-command.js"
import { type Messenger, messengerContext } from "./context.js"
import { countersCommand } from "./counters-command.js"
import { messagesStatsCommand } from "./messages-stats-command.js"
import { officialStatsCommand } from "./official-stats-command.js"
import { rankingEvidenceCommand, rankingsTopCommand } from "./rankings-command.js"
import { retentionCommand } from "./retention-command.js"
import { chartAnswer, refuseJsonl } from "./stats-answers.js"
import { tasksStatsCommand } from "./tasks-command.js"

export const statsCommand = (messenger: Messenger, loadRenderer = chartRenderer): Command => {
  const stats = new Command("stats").description("statistics about messages, chats and their authors")
  stats.addCommand(
    new Command("messages")
      .description("message statistics from the local store")
      .addCommand(messagesStatsCommand(messenger))
      .addCommand(countersCommand(messenger))
      .addCommand(adminStatisticsCommand(messenger, "unanswered"))
      .addCommand(adminStatisticsCommand(messenger, "discussion"))
      .addCommand(rankingsTopCommand(messenger, "messages"))
      .addCommand(rankingEvidenceCommand(messenger, "messages")),
  )
  stats.addCommand(
    new Command("contacts")
      .description("statistics about human authors")
      .addCommand(adminStatisticsCommand(messenger, "responses"))
      .addCommand(rankingsTopCommand(messenger, "contacts"))
      .addCommand(rankingEvidenceCommand(messenger, "contacts")),
  )
  const chats = new Command("chats").description("statistics about one chat").addCommand(chatStatsCommand(messenger))
  chats.addCommand(adminStatisticsCommand(messenger, "newcomers"))
  chats.addCommand(retentionCommand(messenger))
  if (messenger.officialStats === true) chats.addCommand(officialStatsCommand(messenger))
  stats.addCommand(chats)
  stats.addCommand(new Command("tasks").description("task statistics").addCommand(tasksStatsCommand(messenger)))
  destroysNothing(annotate(stats.command("charts"), { effects: LOCAL_WRITE, output: { entity: "chart" } }))
    .description("a chart's data from a chat's statistics, and optionally a dark SVG or PNG image")
    .argument("<chat>", messenger.chatArgument)
    .option(
      "--chart-kind <messages|active|membership>",
      "what to draw: messages, active authors, or joins and leaves",
      chartKindOf,
      "messages",
    )
    .option("--by <group>", "one point per calendar day or week (weeks start on Monday)", chartPeriodOf, "day")
    .option("--since-time <time>", `ISO 8601, or 2h / 1d ago; ${EVENTS_DAYS} days ago if not given`)
    .option("--timezone <zone>", "the IANA timezone for calendar days")
    .option("--output <file>", "write a dark image to a new .svg or .png file")
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      const {
        chartKind,
        by,
        sinceTime,
        timezone: given,
        output,
      } = this.opts<{
        chartKind: ChartKind
        by: ChartPeriod
        sinceTime?: string
        timezone?: string
        output?: string
      }>()
      refuseJsonl(context.format)
      const extension = output === undefined ? undefined : extname(output).toLowerCase()
      if (output !== undefined && extension !== ".svg" && extension !== ".png") {
        throw new CliError(
          "validation_error",
          "--output takes a .svg or .png file; image output to stdout is unavailable",
        )
      }
      const timezone = timezoneOf(given)
      const window = dateWindow({ ...(sinceTime === undefined ? {} : { sinceTime }), zone: timezone })
      const found = await context.withServices((services) =>
        services.chats.stats(chat, { by, timezone, ...(window.since === undefined ? {} : { since: window.since }) }),
      )
      const chart = chatChart(found, { kind: chartKind, by, timezone })
      let chartFile: { path: string; format: "svg" | "png"; width: number; height: number } | undefined
      if (output !== undefined) {
        const svg = await (await loadRenderer()).render(chart, CHART_SIZE)
        const rendered = extension === ".png" ? await chartPng(svg) : svg
        const path = resolve(output)
        try {
          writeFileSync(path, rendered.bytes, { flag: "wx", mode: 0o600 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw new CliError("validation_error", `${path} exists — a chart never overwrites a file`)
          throw error
        }
        chartFile = { path, format: rendered.format, width: rendered.width, height: rendered.height }
        context.renderer.note(`chart written to ${path}`)
      }
      if (chart.partial) context.renderer.note("partial data — the chart shows lower bounds")
      renderAnswer(this, context, chartAnswer(chart, chartFile, window.meta))
    })
  const examples: Record<string, string> = {
    charts: '"Book club" --output ./activity.svg',
    "chats newcomers": '"Book club"',
    "chats retention": '"Book club"',
    "chats show": '"Book club"',
    "contacts evidence": '101 --selection "$selection" --component messages',
    "contacts responses": 'chat:"Project room"',
    "contacts top": 'chat:"Book club" --limit 10',
    "messages counters refresh": '--chat "Book club" --dry-run',
    "messages counters show": '--chat "Book club" --limit 10',
    "messages discussion": 'chat:"Book club"',
    "messages evidence": '"$message" --selection "$selection" --component reactions',
    "messages show": '--chat "Book club" --by day',
    "messages top": 'chat:"Book club" --limit 10',
    "messages unanswered": 'chat:"Project room"',
    "tasks show": '--chat "Project room"',
  }
  for (const [path, args] of Object.entries(examples)) {
    const command = commandAt(stats, path)
    if (command) annotate(command, { examples: [`${messenger.app.command} personal stats ${path} ${args}`] })
  }
  for (const target of ["messages", "contacts"]) {
    commandAt(stats, `${target} evidence`)?.addHelpText(
      "after",
      `\nSet selection to drilldown.selection from stats ${target} top; copy the matching row's ${target === "messages" ? "message locator into message" : "person id"}.\n`,
    )
  }
  return stats
}
