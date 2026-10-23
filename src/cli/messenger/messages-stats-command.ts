import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import type { StatsGrouping } from "../../services/messages-search.js"
import { REMOTE_READ } from "../effects.js"
import { renderAnswer } from "../envelope.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"
import { syncOptions, syncRequest, syncsFirst } from "./search-sync-options.js"
import { countsAnswer, refuseJsonl } from "./stats-answers.js"

const GROUPINGS: StatsGrouping[] = ["chat", "sender", "day", "hour"]

export const messagesStatsCommand = (messenger: Messenger): Command =>
  syncOptions(annotate(new Command("show"), { effects: REMOTE_READ, output: { entity: "message_counts" } }), messenger)
    .summary("count stored messages by chat, sender, day or hour")
    .description(
      `how many stored messages match, by chat, sender, day or hour — the local store only${syncsFirst(messenger) ? "; optionally fetches new messages with --sync-first" : ""}`,
    )
    .argument(
      "[query...]",
      "a strict Lucene query, as for search messages; none counts every stored message; with --saved, more words AND-ed to it",
    )
    .option("--by <group>", "count by chat, sender, day or hour (default: chat)", groupingOf)
    .option("--chat <chat>", `only this chat — the same as chat: in the query; ${messenger.chatArgument}`)
    .option(
      "--source <accounts>",
      "every account of this messenger held in the store; personal, bots or all — the same as in: in the query",
    )
    .option("--limit <n>", "how many rows", positiveCount("--limit"))
    .option("--timezone <zone>", "the IANA timezone for calendar days and hours")
    .option(
      "--exact",
      "bare words and quotes match their exact form only, as exact:word does; text: still matches every form",
    )
    .option(
      "--saved <name|id>",
      "count what a saved search or an earlier run matches; options typed here replace its own",
    )
    .addHelpText(
      "after",
      "Search guide: https://github.com/WireCatLabs/cli-core/blob/main/docs/search/query-language.md",
    )
    .action(async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger)
      refuseJsonl(context.format)
      const {
        by,
        chat,
        source,
        timezone,
        exact,
        limit: typedLimit,
        saved,
      } = this.opts<{
        by?: StatsGrouping
        chat?: string
        source?: string
        timezone?: string
        exact?: boolean
        limit?: number
        saved?: string
      }>()
      const syncing = syncRequest(this, context)
      const typed = {
        ...(by === undefined ? {} : { by }),
        ...(chat === undefined ? {} : { chat }),
        ...(source === undefined ? {} : { source }),
        ...(timezone === undefined ? {} : { timezone }),
        ...(exact ? { exact: true } : {}),
        ...(typedLimit === undefined ? {} : { limit: typedLimit }),
      }
      let limit = context.settings.limit
      const stats = await context.withServices(async (services) => {
        if (saved === undefined)
          return services.messages.stats({
            ...syncing,
            ...typed,
            ...(words.length ? { text: words.join(" ") } : {}),
            by: by ?? "chat",
            limit,
          })
        const { id, params } = await services.searches.resolve(saved, { ...typed, text: words.join(" ") })
        limit = params.limit ?? limit
        return services.messages.stats({
          ...syncing,
          ...(params.text === undefined ? {} : { text: params.text }),
          ...(params.ast === undefined ? {} : { ast: params.ast }),
          ...(params.chat === undefined ? {} : { chat: params.chat }),
          ...(params.source === undefined ? {} : { source: params.source }),
          ...(params.timezone === undefined ? {} : { timezone: params.timezone }),
          ...(params.exact ? { exact: true } : {}),
          by: params.by ?? "chat",
          limit,
          saved: id,
        })
      })
      renderAnswer(this, context, countsAnswer(stats), () => {
        const width = String(Math.max(0, ...stats.items.map(({ count }) => count))).length
        return `${stats.items
          .map(({ key, name, count }) => `${String(count).padStart(width)}  ${name ? `${name} (${key})` : key}`)
          .join("\n")}\n`
      })
      if (context.format === "pretty")
        context.renderer.note(`${stats.total} messages${stats.hasMore ? `; more rows than --limit ${limit}` : ""}`)
    })

export const groupingOf = (value: string): StatsGrouping => {
  if (!(GROUPINGS as string[]).includes(value))
    throw new CliError("validation_error", `--by takes ${GROUPINGS.join(", ")}`)
  return value as StatsGrouping
}
