import { CliError } from "@wirecat/cli-base"
import { Command, Option } from "commander"
import {
  AUTHOR_MEASURES,
  MESSAGE_MEASURES,
  type RankingInput,
  type RankingTarget,
  rankingOptions,
} from "../../domain/rankings-options.js"
import { assertRetentionEvidenceRead } from "../../sends/permissions.js"
import { type AdminEvidenceFound, isAdminSelection } from "../../services/admin-statistics.js"
import { RANKING_SELECTION_BYTES } from "../../services/rankings-selection.js"
import { isRetentionSelection, type RetentionService } from "../../services/retention.js"
import type { SearchParams } from "../../services/searches.js"
import type { RankedEvidence } from "../../store/store.js"
import { environmentOf } from "../context.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"
import { syncOptions, syncRequest } from "./search-sync-options.js"

const selectionOf = (value: string): unknown => {
  if (Buffer.byteLength(value) > RANKING_SELECTION_BYTES)
    throw new CliError("validation_error", "ranking selection must fit within 64 KiB")
  try {
    return JSON.parse(value)
  } catch {
    throw new CliError("validation_error", "--selection takes a JSON object from a ranking drilldown")
  }
}
export const rankingsTopCommand = (messenger: Messenger, target: RankingTarget): Command => {
  const command = syncOptions(new Command("top"))
    .description(
      `rank ${target === "messages" ? "stored messages" : "the human authors of stored messages"} by a measure or explainable score; counters are snapshots with per-field observation freshness`,
    )
    .argument("[query...]", "a strict Lucene query; none selects every stored message")
    .addOption(
      new Option("--measure <name>", "the ranking metric; not with score or weights").choices(
        target === "messages" ? [...MESSAGE_MEASURES] : [...AUTHOR_MEASURES],
      ),
    )
    .addOption(
      new Option("--score <preset>", "helpful/active for authors; engaging for either target").choices([
        "helpful",
        "active",
        "engaging",
      ]),
    )
    .option("--weights <json>", "the complete component weights; replaces preset weights")
    .addOption(
      new Option("--message-kind <kind>", "select proven all, posts or comments before ranking").choices([
        "all",
        "posts",
        "comments",
      ]),
    )
    .option("--chat <chat>", `only this chat; ${messenger.chatArgument}`)
    .option("--source <accounts>", "every held account of this messenger; personal, bots or all")
    .option("--timezone <zone>", "the IANA timezone for dates and active days")
    .option("--exact", "bare words match exact forms rather than stems")
    .option("--limit <n>", "ranked rows, 1–100", positiveCount("--limit"))
    .option("--saved <name|id>", "run a saved query or ranking run; typed options replace stored options")
  if (target === "contacts")
    command.option(
      "--min-messages <n>",
      "minimum selected messages per author; 1, or 5 for engaging",
      positiveCount("--min-messages"),
    )
  command.action(async function (this: Command, words: string[]) {
    const context = messengerContext(this, messenger)
    const options = this.opts<
      RankingInput & {
        weights?: string
        chat?: string
        source?: string
        timezone?: string
        exact?: boolean
        limit?: number
        saved?: string
      }
    >()
    const { saved, ...typed } = options
    let params: SearchParams = { ...typed, ...(words.length ? { text: words.join(" ") } : {}) }
    const found = await context.withServices(async (services) => {
      if (saved !== undefined)
        params = (await services.searches.resolve(saved, { ...params, text: words.join(" ") })).params
      if (params.target !== undefined && params.target !== target)
        throw new CliError("validation_error", "saved ranking belongs to a different target")
      if (params.regex || params.language === "legacy" || params.newest || params.context)
        throw new CliError(
          "validation_error",
          "saved ranking must use strict Lucene without regex/newest/context modes",
        )
      rankingOptions(target, params)
      const sync = syncRequest(this, context)
      return services.rankings.top(target, {
        ...params,
        ...sync,
        language: "lucene",
        limit: params.limit ?? context.settings.limit,
        signal: environmentOf(this).commandSignal ?? environmentOf(this).signal,
        ...(saved ? { saved } : {}),
      })
    })
    if (context.format === "jsonl") context.renderer.stream(found.items)
    else if (context.format !== "pretty") context.renderer.result(found)
    else {
      context.renderer.result(
        found.items.map(({ rank, id, name, value, components, quality }) => ({
          rank,
          id,
          name,
          value,
          components,
          quality,
        })),
      )
      context.renderer.note(
        `${found.eligible} eligible of ${found.population}; ${found.excludedMissing} excluded for missing measurements`,
      )
      context.renderer.note("snapshot counters are cumulative; freshness depends on each field's observation date")
    }
  })
  return command
}

export const rankingEvidenceCommand = (messenger: Messenger, target: RankingTarget): Command =>
  new Command("evidence")
    .description("bounded messages, answer pairs or retention members from an exact drilldown selection")
    .argument(
      target === "messages" ? "<message>" : "<person>",
      target === "messages"
        ? "the canonical message locator, or retention cohort reference, from drilldown"
        : "the exact native person id from the ranking row",
    )
    .requiredOption("--selection <json>", "the resolved ranking selection returned in drilldown", selectionOf)
    .requiredOption("--component <name>", "the exposed ranking component")
    .option("--limit <n>", "evidence rows, 1–100; 20 if not given", positiveCount("--limit"))
    .option("--cursor <cursor>", "continue the same component and stored-evidence fingerprint")
    .action(async function (this: Command, reference: string) {
      const context = messengerContext(this, messenger)
      const options = this.opts<{ selection: unknown; component: string; limit?: number; cursor?: string }>()
      if (isRetentionSelection(options.selection)) assertRetentionEvidenceRead(context.settings.permissions)
      const found = await context.withServices<
        AdminEvidenceFound | RankedEvidence | Awaited<ReturnType<RetentionService["evidence"]>>
      >((services) =>
        (isRetentionSelection(options.selection)
          ? services.retention
          : isAdminSelection(options.selection)
            ? services.adminStatistics
            : services.rankings
        ).evidence(target, reference, options.selection, {
          component: options.component,
          limit: options.limit ?? 20,
          ...(options.cursor ? { cursor: options.cursor } : {}),
          signal: environmentOf(this).commandSignal ?? environmentOf(this).signal,
        }),
      )
      if (context.format === "jsonl") context.renderer.stream(found.items)
      else context.renderer.result(found)
    })
