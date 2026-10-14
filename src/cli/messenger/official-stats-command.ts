import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import type { OfficialChatStats, OfficialPerson, OfficialValue } from "../../domain/models.js"
import { capability } from "../../ports/messenger.js"
import { renderAnswer } from "../envelope.js"
import { type Messenger, messengerContext } from "./context.js"
import { officialAnswer, refuseJsonl } from "./stats-answers.js"

const TOP = 5

export const officialStatsCommand = (messenger: Messenger): Command =>
  annotate(new Command("official"), { output: { entity: "official_stats" } })
    .description(
      `what ${messenger.name ?? messenger.app.command} itself computed for a group or channel you administer: ` +
        "totals against the previous period, top people and every graph as JSON series; the messenger picks the period",
    )
    .argument("<chat>", messenger.chatArgument)
    .action(async function (this: Command, chat: string) {
      const context = messengerContext(this, messenger)
      refuseJsonl(context.format)
      const stats = await context.withMessenger((adapter) =>
        capability(adapter, "officialChatStats", "read its own statistics for a chat")(chat),
      )
      const failed = Object.entries(stats.graphs).filter(([, graph]) => "error" in graph)
      if (failed.length > 0) context.renderer.note(`graphs not given: ${failed.map(([key]) => key).join(", ")}`)
      renderAnswer(this, context, officialAnswer(stats, messenger.provider), () => `${pretty(stats)}\n`)
    })

const value = (name: string, { current, previous }: OfficialValue) => `${name} ${current} (before ${previous})`

const people = <T extends OfficialPerson>(title: string, list: T[], counts: (one: T) => string) =>
  list.length === 0
    ? []
    : [`${title}:`, ...list.slice(0, TOP).map((one) => `  ${one.name ?? one.person}  ${counts(one)}`)]

const pretty = (stats: OfficialChatStats): string => {
  const lines = [`${stats.chat.title} — ${stats.kind}, ${stats.period.since} – ${stats.period.until}`]
  lines.push(...Object.entries(stats.totals).map(([name, totals]) => value(name, totals)))
  if (stats.kind === "group") {
    lines.push(
      ...people("top posters", stats.top.posters, (one) => `${one.messages} messages, ${one.averageChars} chars avg`),
      ...people(
        "top admins",
        stats.top.admins,
        (one) => `${one.deleted} deleted, ${one.removed} removed, ${one.banned} banned`,
      ),
      ...people("top inviters", stats.top.inviters, (one) => `${one.invited} invited`),
    )
  } else {
    lines.push(`notifications on for ${stats.notifications.enabled} of ${stats.notifications.total}`)
    if (stats.recentPosts.length > 0) {
      lines.push(
        "recent posts:",
        ...stats.recentPosts
          .slice(0, TOP)
          .map(
            (post) =>
              `  ${post.kind} ${post.id}  ${post.views} views, ${post.forwards} forwards, ${post.reactions} reactions`,
          ),
      )
    }
  }
  lines.push(
    "graphs:",
    ...Object.entries(stats.graphs).map(([key, graph]) =>
      "error" in graph ? `  ${key}  not given: ${graph.error}` : `  ${key}  ${graph.x.values.length} points`,
    ),
  )
  return lines.join("\n")
}
