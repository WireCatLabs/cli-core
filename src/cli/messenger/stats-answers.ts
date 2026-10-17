import { CliError } from "@wirecat/cli-base"
import type { InferOutput } from "valibot"
import type { ChartData } from "../../charts/model.js"
import type { CounterState } from "../../domain/counters.js"
import { formatLocator } from "../../domain/locator.js"
import type { OfficialChatStats, OfficialPerson } from "../../domain/models.js"
import type { RetentionCohort, RetentionStay } from "../../domain/retention.js"
import type { ENTITIES } from "../../entities/index.js"
import type { AdminEvidenceFound, AdminFound } from "../../services/admin-statistics.js"
import type { ChatStats } from "../../services/chat-stats.js"
import type { MessageStats } from "../../services/messages-search.js"
import type { RankingFound } from "../../services/rankings.js"
import type { RetentionService } from "../../services/retention.js"
import type { AccountKey, RankedEvidence, StoredHit } from "../../store/store.js"
import type { GroupStats } from "../../tasks/index.js"
import { type ItemBody, itemOf, type ListBody, listOf } from "../envelope.js"
import { nextStep } from "../steps.js"
import { chatRef, contactRef } from "./chat-answers.js"
import { coverageGaps } from "./search-answers.js"

type Of<T extends keyof typeof ENTITIES> = InferOutput<(typeof ENTITIES)[T]>
type Selection = Record<string, unknown>
type RetentionFound = Awaited<ReturnType<RetentionService["report"]>>
type RetentionEvidence = Awaited<ReturnType<RetentionService["evidence"]>>
type EvidenceFound = RankedEvidence | AdminEvidenceFound | RetentionEvidence

const iso = (at: number) => new Date(at).toISOString()

const defined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, one]) => one !== undefined)) as T

const truncated = (more: boolean) => (more ? { meta: { truncated: true } } : {})

export const counterReading = (state: CounterState): Of<"counters">["rows"][number]["counters"][number] => ({
  counter: state.counter,
  value: state.value,
  observed_at: state.observedAt,
  source: state.source,
  age_ms: state.ageMilliseconds,
  freshness: state.freshness,
})

interface Drilldown {
  command: string
  arguments: { message?: string; person?: string; selection: unknown; component?: string }
}

/** The top row's way in: its evidence, then the message itself and its neighbours. */
const drilldownSteps = (drilldown: Drilldown | undefined, component: string | undefined, message?: string) => {
  if (!drilldown || component === undefined) return []
  const { message: about, person, selection } = drilldown.arguments
  return [
    nextStep("stats.evidence", {
      command: drilldown.command,
      args: defined({ message: about, person, selection: JSON.stringify(selection), component }),
      values: { component },
    }),
    ...(message === undefined
      ? []
      : [
          nextStep("messages.show", { args: { chat: message } }),
          nextStep("messages.context", { args: { chat: message } }),
        ]),
  ]
}

export const countsAnswer = (stats: MessageStats): ItemBody<Of<"message_counts">> => {
  const refOf = (key: string, account: AccountKey | undefined) =>
    account === undefined
      ? undefined
      : stats.by === "chat"
        ? chatRef(account, key)
        : stats.by === "sender"
          ? contactRef(account.provider, key)
          : undefined
  const gaps = coverageGaps(stats, stats.items.length)
  return itemOf(
    {
      by: stats.by,
      total: stats.total,
      rows: stats.items.map(({ key, name, account, count }) =>
        defined({ key, ref: refOf(key, account), name: name ?? null, count }),
      ),
    },
    { ...gaps, ...truncated(stats.hasMore) },
  )
}

export const rankingAnswer = (found: RankingFound): ItemBody<Of<"ranking">> => {
  const { ranking } = found
  const rows = found.items.map((row) =>
    defined({
      rank: row.rank,
      ref:
        found.ranking.target === "messages"
          ? (row.drilldown.evidence.arguments.message ?? row.id)
          : contactRef(row.account.provider, row.id),
      id: row.id,
      chat_ref: row.chatId === null ? undefined : chatRef(row.account, row.chatId),
      name: row.name,
      kind: row.kind,
      value: row.value,
      components: row.components,
      messages: row.messages,
      known_reactions: row.knownReactions,
      unknown_reactions: row.unknownReactions,
      score: row.ranking,
      quality: {
        reactions: row.quality.reactions,
        graph: row.quality.graph,
        counter_freshness: row.quality.counterFreshness,
      },
      counters: row.counterObservations?.map(counterReading),
      selection: row.drilldown.selection as unknown as Selection,
    }),
  )
  const top = found.items[0]
  const gaps = coverageGaps(found, found.items.length)
  return itemOf(
    defined({
      target: ranking.target,
      measure: ranking.measure,
      order: ranking.order,
      preset: ranking.preset,
      weights: (ranking.weights ?? null) as Record<string, number> | null,
      min_messages: ranking.minMessages,
      message_kind: ranking.messageKind,
      total: found.total,
      population: found.population,
      eligible: found.eligible,
      excluded: {
        minimum: found.excludedMinimum,
        missing: found.excludedMissing,
        unknown_sender: found.excludedUnknownSender,
        unknown_kind: found.excludedUnknownKind,
      },
      maxima: found.maxima as Record<string, number>,
      counter_freshness: ranking.counterFreshness,
      expanded_discussion_chats: found.expandedDiscussionChats,
      rows,
    }),
    {
      next: [
        ...drilldownSteps(
          top && { command: top.drilldown.evidence.command, arguments: top.drilldown.evidence.arguments },
          top?.drilldown.evidence.components[0],
          top?.drilldown.context?.arguments.message,
        ),
        ...gaps.next,
      ],
      missing: gaps.missing,
      ...truncated(found.hasMore),
    },
  )
}

export const adminAnswer = (found: AdminFound): ItemBody<Of<"admin_report">> => {
  const rows = found.items.map((row) => {
    const message = row.message ?? (row.id.startsWith("msg:") ? row.id : undefined)
    return defined({
      ref: message ?? (found.report === "responses" ? contactRef(row.account.provider, row.id) : row.id),
      id: row.id,
      status: row.status,
      chat_ref: row.chatId === undefined ? undefined : chatRef(row.account, row.chatId),
      person_ref: row.personId === undefined ? undefined : contactRef(row.account.provider, row.personId),
      identity_known: row.identityKnown,
      questions: row.questions,
      answered: row.answered,
      median_ms: row.medianMilliseconds,
      p90_ms: row.p90Milliseconds,
      age_ms: row.ageMilliseconds,
      joined_at: row.joinedAt,
      window_end: row.windowEnd,
      pending: row.pending,
      views: row.views,
      observed_replies: row.observedReplies,
      comment_snapshot: row.commentSnapshot,
      counters: row.counterObservations?.map(counterReading),
      selection: row.drilldown.arguments.selection as unknown as Selection,
    })
  })
  const top = found.items[0]
  const { summary, quality } = found
  return itemOf(
    {
      report: found.report,
      cutoff: found.cutoff,
      total: found.total,
      summary: {
        questions: summary.questions,
        answered: summary.answered,
        no_observed_answer: summary.noObservedAnswer,
        excluded_future: summary.excludedFuture,
        unknown_join: summary.unknownJoin,
        missing_views: summary.missingViews,
      },
      quality: {
        graph: {
          unknown_links: quality.graph.unknownLinks,
          unknown_authors: quality.graph.unknownAuthors,
          missing_parents: quality.graph.missingParents,
          cycles: quality.graph.cycles,
          complete: quality.graph.complete,
        },
        archives: quality.archives.map(({ account, chatId, state, fetchedAt }) => ({
          chat_ref: chatRef(account, chatId),
          state,
          fetched_at: fetchedAt,
        })),
        archives_total: quality.archivesTotal,
        membership: quality.membership,
        counter_freshness: quality.counterFreshness,
        answerer_roles: quality.answererRoles,
      },
      rows,
    },
    {
      next: drilldownSteps(
        top?.drilldown,
        top?.drilldown.arguments.component,
        top?.message ?? (top?.id.startsWith("msg:") ? top.id : undefined),
      ),
      ...truncated(found.hasMore),
    },
  )
}

const cohortRow = (row: RetentionCohort & { drilldown: Drilldown }): Of<"retention">["rows"][number] => ({
  cohort: row.cohort,
  stays: row.stays,
  checkpoints: row.checkpoints.map(({ ageMilliseconds, ...counts }) => ({ age_ms: ageMilliseconds, ...counts })),
  activity: {
    observed: row.activity.observed,
    no_observed: row.activity.noObserved,
    pending: row.activity.pending,
    archive_covered: row.activity.archiveCovered,
  },
  early_departure: {
    observed: row.earlyDeparture.observed,
    not_observed: row.earlyDeparture.notObserved,
    unknown: row.earlyDeparture.unknown,
    pending: row.earlyDeparture.pending,
  },
  selection: row.drilldown.arguments.selection as Selection,
})

export const retentionAnswer = (found: RetentionFound): ItemBody<Of<"retention">> => {
  const { options, quality } = found
  const top = found.items[0]
  return itemOf(
    {
      chat_ref: chatRef(found.account, found.chatId),
      cutoff: found.cutoff,
      since: iso(options.since),
      until: iso(options.until),
      checkpoints_ms: options.checkpoints,
      within_ms: options.within,
      by: options.by,
      timezone: options.timezone,
      total: found.total,
      unknown_join: found.unknownJoin,
      eligible_stays: found.eligibleStays,
      quality: {
        membership: quality.membership,
        tolerance_ms: quality.toleranceMilliseconds,
        archive:
          quality.archive === null
            ? null
            : {
                state: quality.archive.state,
                up_to_date: quality.archive.upToDate,
                gaps: quality.archive.gaps,
                reaches_start: quality.archive.reachesStart,
                fetched_at: quality.archive.fetchedAt,
              },
        continuous_survival: quality.continuousSurvival,
        group_silent_rate: quality.groupSilentRate,
      },
      rows: found.items.map(cohortRow),
    },
    {
      next: drilldownSteps(top?.drilldown, top?.drilldown.arguments.component),
      ...truncated(found.hasMore),
    },
  )
}

const evidenceMessage = (hit: StoredHit) => ({
  ref: hit.locator,
  chat_title: hit.chatTitle ?? null,
  timestamp: hit.timestamp,
  sender_name: hit.senderName,
  text: hit.text,
})

const stayItem = (stay: RetentionStay, account: AccountKey): Of<"evidence"> => ({
  person_ref: contactRef(account.provider, stay.person),
  joined_at: stay.joinedAt,
  cohort: stay.cohort,
  checkpoints: stay.checkpoints.map((one) => ({
    checkpoint_ms: one.checkpoint,
    target_at: one.targetAt,
    state: one.state,
    observed_at: one.observedAt,
    lag_ms: one.lagMilliseconds,
    complete: one.complete === true,
  })),
  activity: {
    state: stay.activity.state,
    first_message_at: stay.activity.firstMessageAt,
    window_end: stay.activity.windowEnd,
    archive_covered: stay.activity.archiveCovered,
  },
  departure: { after: stay.departure.after, at_or_before: stay.departure.atOrBefore, early: stay.departure.early },
})

interface Contribution {
  message: StoredHit
  related?: StoredHit
  contribution: number | null
  counters?: CounterState[]
}

const contributionItem = (one: Contribution): Of<"evidence"> =>
  defined({
    message: evidenceMessage(one.message),
    related: one.related && evidenceMessage(one.related),
    contribution: one.contribution,
    counters: one.counters?.map(counterReading),
  })

/** `stats * evidence`: one page of what lies behind a row, from its selection. */
export const evidenceAnswer = (
  command: string,
  found: EvidenceFound,
  args: Record<string, unknown>,
  limit: number,
): ListBody<Of<"evidence">> => {
  const items =
    "evidenceTotal" in found
      ? found.items.map((stay) => stayItem(stay, found.account))
      : (found.items as Contribution[]).map(contributionItem)
  const cursor = found.nextCursor ?? undefined
  return listOf(command, {
    items,
    limit,
    has_more: found.hasMore && cursor !== undefined,
    paging: "cursor",
    ...(cursor === undefined ? {} : { cursor }),
    args,
  })
}

type CountersShown = {
  items: { locator: string; counters: CounterState[] }[]
  hasMore: boolean
  cutoff: string
  maxAgeMilliseconds: number
  selection: { kind: string; version: number; locators: string[] }
}

export const countersAnswer = (found: CountersShown): ItemBody<Of<"counters">> =>
  itemOf(
    {
      cutoff: found.cutoff,
      max_age_ms: found.maxAgeMilliseconds,
      selection: { kind: "counter-targets", version: 1, locators: found.selection.locators },
      rows: found.items.map(({ locator, counters }) => ({ ref: locator, counters: counters.map(counterReading) })),
    },
    truncated(found.hasMore),
  )

type Refreshed = {
  dryRun: boolean
  targets: string[]
  counters: string[]
  supported: string[]
  unsupported: string[]
  maxMessages: number
  timeMilliseconds: number
  hasMore: boolean
  items?: { locator: string; updated: string[]; missing: string[]; status: string }[]
  stopped?: string
  complete?: boolean
}

export const refreshAnswer = (found: Refreshed): ItemBody<Of<"counter_refresh">> =>
  itemOf(
    defined({
      dry_run: found.dryRun,
      targets: found.targets,
      counters: found.counters,
      supported: found.supported,
      unsupported: found.unsupported,
      max_messages: found.maxMessages,
      time_ms: found.timeMilliseconds,
      results: found.items?.map(({ locator, updated, missing, status }) => ({
        ref: locator,
        updated,
        missing,
        status,
      })),
      stopped: found.stopped,
      complete: found.complete,
    }),
    truncated(found.hasMore),
  )

const snake = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

export const officialAnswer = (stats: OfficialChatStats, provider: string): ItemBody<Of<"official_stats">> => {
  const person = ({ person, name }: OfficialPerson) => ({ person_ref: contactRef(provider, person), name })
  return itemOf(
    defined({
      chat_id: stats.chat.id,
      title: stats.chat.title,
      kind: stats.kind,
      since: stats.period.since,
      until: stats.period.until,
      totals: Object.fromEntries(Object.entries(stats.totals).map(([key, value]) => [snake(key), value])),
      top:
        stats.kind === "group"
          ? {
              posters: stats.top.posters.map((one) => ({
                ...person(one),
                messages: one.messages,
                average_chars: one.averageChars,
              })),
              admins: stats.top.admins.map((one) => ({
                ...person(one),
                deleted: one.deleted,
                removed: one.removed,
                banned: one.banned,
              })),
              inviters: stats.top.inviters.map((one) => ({ ...person(one), invited: one.invited })),
            }
          : undefined,
      notifications: stats.kind === "channel" ? stats.notifications : undefined,
      recent_posts: stats.kind === "channel" ? stats.recentPosts : undefined,
      graphs: stats.graphs,
    }),
  )
}

export const chartAnswer = (
  chart: ChartData,
  file?: { path: string; format: "svg" | "png"; width: number; height: number },
): ItemBody<Of<"chart">> => itemOf(defined({ ...chart, file }))

/** A report or a chart is one object: `--jsonl` would print one line pretending to be a stream. */
export const refuseJsonl = (format: string): void => {
  if (format === "jsonl")
    throw new CliError("validation_error", "a report is one JSON object — use --json, not --jsonl", {
      reason: "output.one-object",
    })
}

/** `stats chats show`, CLI and MCP alike; a chat the store does not hold whole names the sync that fills it. */
export const chatStatsAnswer = (stats: ChatStats, account: AccountKey): ItemBody<Of<"chat_stats">> => {
  const { chatId, completeness, topPosts, questions, memberCounts, members, series, fetch } = stats
  const item = defined({
    chat: chatRef(account, chatId),
    since: stats.since,
    until: stats.until,
    complete: stats.complete,
    completeness: {
      state: completeness.state,
      up_to_date: completeness.upToDate,
      gaps: completeness.gaps,
      reaches_start: completeness.reachesStart,
      fetched_at: completeness.fetchedAt,
    },
    messages: stats.messages,
    senders: stats.senders,
    replies: stats.replies,
    threads: stats.threads,
    reactions: stats.reactions,
    views: stats.views,
    forwards: stats.forwards,
    comments: stats.comments,
    top_posts: topPosts.map((post) =>
      defined({
        ref: formatLocator({
          provider: account.provider,
          account: account.account,
          chat: chatId,
          message: post.messageId,
        }),
        timestamp: post.timestamp,
        reactions: post.reactions,
        views: post.views,
        forwards: post.forwards,
        comments: post.comments,
      }),
    ),
    questions: {
      asked: questions.asked,
      answered: questions.answered,
      median_minutes_to_answer: questions.medianMinutesToAnswer,
      answered_by: questions.answeredBy,
    },
    member_counts: memberCounts,
    members:
      members &&
      defined({
        joined: members.joined,
        left: members.left,
        net: members.net,
        wrote: members.wrote,
        median_minutes_to_first_message: members.medianMinutesToFirstMessage,
        more: members.more,
      }),
    series: series?.map((row) => defined({ ...row })),
  })
  return itemOf(
    item,
    completeness.state === "complete"
      ? {}
      : {
          missing: [
            {
              field: "messages",
              why: "the store does not hold this chat whole, so these are lower bounds",
              ...(fetch === undefined ? {} : { step: "messages.sync" }),
            },
          ],
          ...(fetch === undefined ? {} : { next: [nextStep("messages.sync", { args: { chat: chatId } })] }),
        },
  )
}

/** `stats tasks show`, CLI and MCP alike. */
export const taskStatsAnswer = (rows: GroupStats[], account: AccountKey): ItemBody<Of<"task_stats">> =>
  itemOf({
    open: rows.reduce((sum, row) => sum + row.open, 0),
    rows: rows.map((row) => ({
      chat: chatRef(account, row.group),
      open: row.open,
      oldest_open_at: row.oldestOpenAt?.toISOString() ?? null,
      median_close_ms: row.medianCloseMs ?? null,
    })),
  })
