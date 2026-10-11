import { CliError } from "@wirecat/cli-base"
import { Command } from "commander"
import type { StatsGrouping } from "../../services/messages-search.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"
import { syncOptions, syncRequest } from "./search-sync-options.js"

const GROUPINGS: StatsGrouping[] = ["chat", "sender", "day", "hour"]

export const messagesStatsCommand = (messenger: Messenger): Command =>
  syncOptions(new Command("show"))
    .description(
      "how many stored messages match, by chat, sender, day or hour — the local store only; optionally fetches new messages with --sync-first",
    )
    .argument(
      "[query...]",
      "a strict Lucene query, as for search messages; none counts every stored message; with --saved, more words AND-ed to it",
    )
    .option("--by <chat|sender|day|hour>", "what to count by (default: chat)", groupingOf)
    .option("--chat <chat>", `only this chat — the same as chat: in the query; ${messenger.chatArgument}`)
    .option(
      "--source <messenger>",
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
      "Search guide: https://github.com/WireCatLabs/cli-messaging/blob/main/docs/search/query-language.md",
    )
    .action(async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger)
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
            language: "lucene",
          })
        const { id, params } = await services.searches.resolve(saved, { ...typed, text: words.join(" ") })
        if (params.regex || params.language === "legacy")
          throw new CliError(
            "validation_error",
            "stats messages show counts strict Lucene queries; this saved search is legacy",
          )
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
          language: "lucene",
          saved: id,
        })
      })
      const incomplete = stats.completeness.filter((one) => one.state !== "complete").length
      if (incomplete > 0)
        context.renderer.note(
          `${incomplete} of the chats counted are not held in full, so these are lower bounds — \`${messenger.app.command} store fetch <chat>\` fetches one`,
        )
      if (context.format === "pretty") {
        const width = String(Math.max(0, ...stats.items.map(({ count }) => count))).length
        context.streams.data(
          stats.items
            .map(({ key, name, count }) => `${String(count).padStart(width)}  ${name ? `${name} (${key})` : key}`)
            .join("\n"),
        )
        context.renderer.note(`${stats.total} messages${stats.hasMore ? `; more rows than --limit ${limit}` : ""}`)
        return
      }
      if (context.format === "jsonl") context.renderer.stream(stats.items)
      else context.renderer.result({ ...stats, page: 1, limit })
    })

export const groupingOf = (value: string): StatsGrouping => {
  if (!(GROUPINGS as string[]).includes(value))
    throw new CliError("validation_error", `--by takes ${GROUPINGS.join(", ")}`)
  return value as StatsGrouping
}
