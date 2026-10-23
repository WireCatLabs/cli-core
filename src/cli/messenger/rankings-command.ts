import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
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
import type { SearchParams } from "../../services/search-record.js"
import type { RankedEvidence } from "../../store/store.js"
import { environmentOf } from "../context.js"
import { LOCAL_READ, REMOTE_READ } from "../effects.js"
import { renderAnswer } from "../envelope.js"
import { positiveCount } from "../paging.js"
import { type Messenger, messengerContext } from "./context.js"
import { syncOptions, syncRequest } from "./search-sync-options.js"
import { statisticsQuery, withStatisticsQuery } from "./statistics-query.js"
import { evidenceAnswer, rankingAnswer, refuseJsonl } from "./stats-answers.js"

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
  const command = syncOptions(
    annotate(new Command("top"), { effects: REMOTE_READ, output: { entity: "ranking" } }),
    messenger,
  )
    .summary("rank messages or people by a measure or score")
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
    .option("--source <accounts>", "every held account of this messenger; personal, bots or all")
    .option("--timezone <zone>", "the IANA timezone for dates and active days")
    .option("--limit <n>", "ranked rows, 1–100", positiveCount("--limit"))
    .option("--saved <name|id>", "run a saved query or ranking run; typed options replace stored options")
  const report = target === "contacts" ? "contacts-top" : "messages-top"
  withStatisticsQuery(command, report)
  command.action(async function (this: Command, words: string[]) {
    const filters = statisticsQuery(words, report)
    const context = messengerContext(this, messenger)
    refuseJsonl(context.format)
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
    let params: SearchParams = { ...typed, ...filters }
    const found = await context.withServices(async (services) => {
      if (saved !== undefined)
        params = (await services.searches.resolve(saved, { ...params, text: filters.text ?? "" })).params
      if (params.target !== undefined && params.target !== target)
        throw new CliError("validation_error", "saved ranking belongs to a different target")
      if (params.newest || params.context)
        throw new CliError("validation_error", "saved ranking must not use newest/context modes")
      rankingOptions(target, params)
      const sync = syncRequest(this, context)
      return services.rankings.top(target, {
        ...params,
        ...sync,
        limit: params.limit ?? context.settings.limit,
        signal: environmentOf(this).commandSignal ?? environmentOf(this).signal,
        ...(saved ? { saved } : {}),
      })
    })
    renderAnswer(this, context, rankingAnswer(found), () =>
      [
        ...found.items.map(({ rank, name, id, value, reactions }) =>
          [`${rank}. ${name ?? id}  ${value}`, reactions?.length ? emojiSplit(reactions) : undefined]
            .filter(Boolean)
            .join("  "),
        ),
        `${found.eligible} eligible of ${found.population}; ${found.excludedMissing} excluded for missing measurements`,
        "",
      ].join("\n"),
    )
  })
  return command
}

const SHOWN_REACTIONS = 5
const emojiSplit = (reactions: readonly { reaction: string; count: number }[]) =>
  [
    ...reactions.slice(0, SHOWN_REACTIONS).map(({ reaction, count }) => `${reaction} ${count}`),
    ...(reactions.length > SHOWN_REACTIONS ? [`+${reactions.length - SHOWN_REACTIONS}`] : []),
  ].join(" · ")

export const rankingEvidenceCommand = (messenger: Messenger, target: RankingTarget): Command =>
  annotate(new Command("evidence"), { effects: LOCAL_READ, output: { entity: "evidence" } })
    .summary("evidence for an exact statistics selection")
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
      const limit = options.limit ?? 20
      const body = evidenceAnswer(
        `stats ${target} evidence`,
        found,
        {
          [target === "messages" ? "message" : "person"]: reference,
          selection: JSON.stringify(options.selection),
          component: options.component,
        },
        limit,
      )
      renderAnswer(this, context, body)
    })
