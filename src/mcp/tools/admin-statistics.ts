import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { adminAnswer, countersAnswer, refreshAnswer, retentionAnswer } from "../../cli/messenger/stats-answers.js"
import type { AdminQuery } from "../../services/admin-statistics.js"
import type { CounterQuery } from "../../services/counters.js"
import { searchServices } from "../search-sync.js"
import { type AnyTool, READ, tool } from "../tool.js"

const common = {
  saved: v.optional(v.string()),
  timezone: v.optional(v.string()),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
}
const query = {
  ...common,
  text: v.optional(v.string()),
  ast: v.optional(v.unknown()),
  chat: v.optional(
    v.pipe(
      v.string(),
      v.description(
        "Stored chat ID, @username or title fragment; use chats list to discover IDs. Never guess ambiguous titles.",
      ),
    ),
  ),
  source: v.optional(v.string()),
  exact: v.optional(v.boolean()),
}
const people = {
  answerer: v.optional(
    v.array(
      v.pipe(
        v.string(),
        v.description(
          "Stored name, alias, @username, ID or person:provider/account/id, resolved only in query accounts. Unknown names fail; ambiguous names return candidates. Explicit unseen IDs remain unknown, not evidence of zero activity.",
        ),
      ),
    ),
  ),
}
export const adminStatisticsTools = (messenger: Messenger): Record<string, AnyTool> => {
  const definitions: Record<string, AnyTool> = {}
  for (const report of ["unanswered", "responses", "newcomers", "discussion"] as const) {
    const path = report === "responses" ? "contacts" : report === "newcomers" ? "chats" : "messages"
    const entries: v.ObjectEntries =
      report === "newcomers"
        ? {
            ...common,
            ...people,
            chat: v.pipe(
              v.string(),
              v.description(
                "Stored chat ID, @username or title fragment; ambiguous titles require choosing a candidate.",
              ),
            ),
            since_time: v.optional(v.string()),
            until_time: v.optional(v.string()),
            within: v.optional(v.string()),
          }
        : report === "discussion"
          ? {
              ...query,
              min_views: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
              max_replies: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
            }
          : {
              ...query,
              ...people,
              ...(report === "unanswered" ? { older_than: v.optional(v.string()) } : {}),
            }
    const input = v.object(entries)
    definitions[`stats_${path}_${report}`] = tool({
      title: `Stored ${report} report`,
      description:
        "Administrator statistics from authorized stored history only. Explicit qualifying replies; selected answerer identities do not prove historical admin roles. Missing joining dates, reply history and counters remain unknown or partial. Each row carries the selection its evidence takes; next names the top row's evidence. No fetch, sends, mark-read or model calls.",
      input,
      annotations: { ...READ, openWorldHint: false },
      output: { entity: "admin_report", list: false },
      stored: async (store, account, args, defaults) => {
        const services = searchServices(messenger, store, account, defaults)
        const values = args as Partial<AdminQuery> & {
          answerer?: string[]
          older_than?: string
          since_time?: string
          until_time?: string
          min_views?: number
          max_replies?: number
        }
        const found = await services.adminStatistics.report(report, {
          limit: values.limit ?? 20,
          timezone: values.timezone,
          saved: values.saved,
          signal: defaults.signal,
          text: values.text,
          ast: values.ast,
          chat: values.chat,
          source: values.source,
          exact: values.exact,
          answerers: values.answerer,
          olderThan: values.older_than,
          within: values.within,
          sinceTime: values.since_time,
          untilTime: values.until_time,
          minViews: values.min_views,
          maxReplies: values.max_replies,
        })
        return adminAnswer(found)
      },
    })
  }
  definitions.stats_chats_retention = tool({
    title: "Observed retention cohorts",
    description:
      "Known joining cohorts, observed checkpoint membership, activity and interval departures from saved roster batches. Partial absences and missing joins remain unknown. Rates expose observed denominators. No connection or message actions.",
    input: v.object({
      chat: v.pipe(
        v.string(),
        v.description("Stored chat ID, @username or title fragment; ambiguous titles require choosing a candidate."),
      ),
      since_time: v.optional(v.string()),
      until_time: v.optional(v.string()),
      checkpoints: v.optional(v.string()),
      within: v.optional(v.string()),
      by: v.optional(v.picklist(["day", "week"])),
      timezone: v.optional(v.string()),
      limit: common.limit,
    }),
    annotations: { ...READ, openWorldHint: false },
    output: { entity: "retention", list: false },
    stored: async (store, account, args, defaults) =>
      retentionAnswer(
        await searchServices(messenger, store, account, defaults).retention.report(args.chat, {
          sinceTime: args.since_time,
          untilTime: args.until_time,
          checkpoints: args.checkpoints,
          within: args.within,
          by: args.by,
          timezone: args.timezone,
          limit: args.limit,
        }),
      ),
  })
  for (const operation of ["show", "refresh"] as const) {
    const entries: v.ObjectEntries = {
      text: query.text,
      ast: query.ast,
      chat: query.chat,
      source: query.source,
      exact: query.exact,
      timezone: query.timezone,
      limit: common.limit,
      selection: v.optional(v.unknown()),
      counters: v.optional(v.string()),
      ...(operation === "show" ? { max_age: v.optional(v.string()) } : {}),
      ...(operation === "refresh"
        ? {
            max_messages: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
            sync_time: v.optional(v.string()),
            dry_run: v.optional(v.boolean()),
          }
        : {}),
    }
    definitions[`stats_messages_counters_${operation}`] = tool({
      title: `Counter observations ${operation}`,
      description:
        operation === "show"
          ? "Bounded stored counter values with explicit per-field observation freshness and pinned exact locators."
          : "Bounded remote counter read and local observation write. Requires explicit chat or pinned selection. No send, mark-read or view increment. Dry run resolves targets and capabilities without connecting.",
      input: v.object(entries),
      annotations: {
        ...READ,
        readOnlyHint: operation === "show",
        destructiveHint: false,
        openWorldHint: operation === "refresh",
      },
      key: `stats.messages.counters.${operation}`,
      output: { entity: operation === "show" ? "counters" : "counter_refresh", list: false },
      stored: async (store, account, args, defaults, connect) => {
        const values = args as Partial<CounterQuery> & {
          max_age?: string
          max_messages?: number
          sync_time?: string
          dry_run?: boolean
        }
        const counters = searchServices(
          messenger,
          store,
          account,
          defaults,
          operation === "refresh" && values.dry_run !== true ? connect : undefined,
        ).counters
        const query = {
          text: values.text,
          ast: values.ast,
          chat: values.chat,
          source: values.source,
          exact: values.exact,
          timezone: values.timezone,
          selection: values.selection,
          counters: values.counters,
          maxAge: values.max_age,
          limit: values.limit ?? 20,
          maxMessages: values.max_messages,
          syncTime: values.sync_time,
          dryRun: values.dry_run,
          signal: defaults.signal,
        }
        return operation === "show"
          ? countersAnswer(await counters.show(query))
          : refreshAnswer(await counters.refresh(query))
      },
    })
  }
  return definitions
}
