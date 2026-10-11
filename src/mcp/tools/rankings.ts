import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { AUTHOR_MEASURES, MESSAGE_MEASURES, type RankingTarget } from "../../domain/rankings-options.js"
import { assertRetentionEvidenceRead } from "../../sends/permissions.js"
import { isAdminSelection } from "../../services/admin-statistics.js"
import { isRetentionSelection } from "../../services/retention.js"
import type { SearchParams } from "../../services/searches.js"
import { searchServices, syncInputs } from "../search-sync.js"
import { type AnyTool, READ, tool } from "../tool.js"
import { syncArgs } from "./search.js"

const commonTop = {
  ...syncInputs,
  text: v.optional(v.string()),
  ast: v.optional(v.unknown()),
  chat: v.optional(v.string()),
  source: v.optional(v.string()),
  timezone: v.optional(v.string()),
  exact: v.optional(v.boolean()),
  saved: v.optional(v.string()),
  weights: v.optional(v.union([v.string(), v.record(v.string(), v.number())])),
  message_kind: v.optional(v.picklist(["all", "posts", "comments"])),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
}
const topInput = (target: RankingTarget) =>
  target === "messages"
    ? v.object({
        ...commonTop,
        measure: v.optional(v.picklist(MESSAGE_MEASURES)),
        score: v.optional(v.picklist(["engaging"])),
      })
    : v.object({
        ...commonTop,
        measure: v.optional(v.picklist(AUTHOR_MEASURES)),
        score: v.optional(v.picklist(["helpful", "active", "engaging"])),
        min_messages: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
      })
const commonEvidence = {
  selection: v.union([v.string(), v.record(v.string(), v.unknown())]),
  component: v.string(),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
  cursor: v.optional(v.pipe(v.string(), v.maxLength(4096))),
}
const evidenceInput = (target: RankingTarget) =>
  target === "messages"
    ? v.object({ ...commonEvidence, message: v.string() })
    : v.object({ ...commonEvidence, person: v.string() })

export const rankingTools = (messenger: Messenger): Record<string, AnyTool> => {
  const definitions: Record<string, AnyTool> = {}
  for (const target of ["messages", "contacts"] as const) {
    definitions[`stats_${target}_top`] = tool({
      title: `Rank ${target === "messages" ? "messages" : "authors"}`,
      description:
        "Rank the local matching population by a measure or explainable score; limit is applied after normalization. Unknown counters are not zero. Per-counter observation freshness is disclosed and counts are cumulative snapshots; graph counts describe stored events in the query period. Returns coverage, exclusions, score components and a resolved drilldown selection. No sends or mark-read; optional sync_first has separate write permissions.",
      input: topInput(target),
      annotations: { ...READ, openWorldHint: false },
      stored: async (store, account, args, defaults, connect) => {
        const services = searchServices(messenger, store, account, defaults, args.sync_first ? connect : undefined)
        const min_messages =
          "min_messages" in args && typeof args.min_messages === "number" ? args.min_messages : undefined
        const {
          message_kind,
          saved,
          sync_first: _sync,
          sync_time: _time,
          max_chats: _chats,
          max_messages: _messages,
          ...plain
        } = args
        let params: SearchParams = {
          ...plain,
          ...(min_messages === undefined ? {} : { minMessages: min_messages }),
          ...(message_kind === undefined ? {} : { messageKind: message_kind }),
        }
        if (saved !== undefined) {
          if (args.ast !== undefined)
            throw new CliError("validation_error", "with saved, give extra query words rather than an AST")
          params = (await services.searches.resolve(saved, params)).params
        }
        if (params.target !== undefined && params.target !== target)
          throw new CliError("validation_error", "saved ranking belongs to a different target")
        if (params.regex || params.language === "legacy" || params.newest || params.context)
          throw new CliError(
            "validation_error",
            "saved ranking must use strict Lucene without regex/newest/context modes",
          )
        return services.rankings.top(target, {
          ...params,
          ...syncArgs(args),
          language: "lucene",
          limit: params.limit ?? defaults.limit,
          signal: defaults.signal,
          ...(saved ? { saved } : {}),
        })
      },
    })
    definitions[`stats_${target}_evidence`] = tool({
      title: `Inspect ${target} ranking evidence`,
      description:
        "Page through contributing messages, question/answer pairs or retention cohort members from a resolved drilldown selection. Never fetches, sends, marks read or records evidence bodies. A cursor binds the component, selection and contributing stored rows; changed evidence requires a restart. JSON items are bounded to 64 KiB; total, included and nextCursor describe continuation.",
      input: evidenceInput(target),
      annotations: { ...READ, openWorldHint: false },
      stored: (store, account, args, defaults) => {
        const services = searchServices(messenger, store, account, defaults)
        if (isRetentionSelection(args.selection)) assertRetentionEvidenceRead(defaults.settings.permissions ?? {})
        const reference = "message" in args ? args.message : args.person
        if (reference === undefined)
          throw new CliError("validation_error", "ranking evidence needs its exact message or person reference")
        return (
          isRetentionSelection(args.selection)
            ? services.retention
            : isAdminSelection(args.selection)
              ? services.adminStatistics
              : services.rankings
        ).evidence(target as RankingTarget, reference, args.selection, {
          component: args.component,
          limit: args.limit ?? 20,
          ...(args.cursor ? { cursor: args.cursor } : {}),
          signal: defaults.signal,
        })
      },
    })
  }
  return definitions
}
