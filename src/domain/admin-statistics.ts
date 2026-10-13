import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import { formatLocator } from "./locator.js"
import { RANKING_GRAPH_LIMITS, type RankingGraphNode, rankReplyGraph } from "./rankings-graph.js"
import { rankingQuestion } from "./rankings-options.js"

export type AdminReport = "unanswered" | "responses" | "newcomers" | "discussion"
export interface Answerer {
  provider: string
  account: string
  id: string
}
export interface AdminOptions {
  report: AdminReport
  cutoff: number
  olderThan: number
  within: number
  joinSince: number
  joinUntil: number
  minViews: number
  maxReplies: number
  answerers: Answerer[]
}
export interface AdminNode extends RankingGraphNode {
  views: number | null
  comments: number | null
  bot: boolean
}
export interface AdminStay {
  id: string
  account: { provider: string; account: string }
  chatId: string
  joinedAt: number | null
  firstSeenAt: number
  goneAt: number | null
}
export interface AdminRow {
  identityKnown?: boolean
  counterObservations?: import("./counters.js").CounterState[]
  id: string
  account: { provider: string; account: string }
  chatId?: string
  personId?: string
  message?: string
  questions?: number
  answered?: number
  medianMilliseconds?: number | null
  p90Milliseconds?: number | null
  ageMilliseconds?: number
  joinedAt?: string
  windowEnd?: string
  pending?: boolean
  views?: number
  observedReplies?: number
  commentSnapshot?: number | null
  status: "observed" | "no-observed-answer" | "partial" | "unknown"
}
export interface AdminContribution {
  pk: number
  related?: number
  contribution: number | null
}
export interface AdminCalculated {
  items: AdminRow[]
  evidence: Map<string, AdminContribution[]>
  summary: {
    questions: number
    answered: number
    noObservedAnswer: number
    excludedFuture: number
    unknownJoin: number
    missingViews: number
  }
  graph: ReturnType<typeof rankReplyGraph>["quality"]
}
export const adminEntityKey = (row: Pick<AdminRow, "account" | "id">): string =>
  JSON.stringify([row.account.provider, row.account.account, row.id])
const personKey = (node: Pick<AdminNode, "account" | "sender">) =>
  JSON.stringify([node.account.provider, node.account.account, node.sender])
const locator = (node: RankingGraphNode) => formatLocator({ ...node.account, chat: node.chatId, message: node.id })
const stats = (delays: number[]) => {
  const sorted = delays.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return {
    medianMilliseconds: sorted.length
      ? sorted.length % 2
        ? (sorted[middle] as number)
        : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
      : null,
    p90Milliseconds: sorted.length ? (sorted[Math.ceil(sorted.length * 0.9) - 1] as number) : null,
  }
}

export const calculateAdminStatistics = (
  nodes: AdminNode[],
  stays: AdminStay[],
  options: AdminOptions,
  inspect: () => void,
): AdminCalculated => {
  let work = 0
  const check = () => {
    inspect()
    if (++work > RANKING_GRAPH_LIMITS.work)
      throw new CliError("validation_error", "admin statistics work budget exceeded — narrow scope", {
        reason: "query.too-large",
        complete: false,
      })
  }
  const graph = rankReplyGraph(nodes, check)
  const byPk = new Map(nodes.map((node) => [node.pk, node]))
  const selectedAnswerers = new Set(options.answerers.map((one) => personKey({ account: one, sender: one.id })))
  const human = (node: AdminNode) => node.sender !== null && !node.senderIsChat && !node.bot
  const questions = nodes.filter(
    (node) => node.selected && human(node) && rankingQuestion(node.text) && !selectedAnswerers.has(personKey(node)),
  )
  const summary = { questions: 0, answered: 0, noObservedAnswer: 0, excludedFuture: 0, unknownJoin: 0, missingViews: 0 }
  const answers = new Map<number, AdminNode>()
  for (const node of nodes) {
    check()
    const parent = byPk.get(graph.parents.get(node.pk) ?? -1)
    if (
      !parent ||
      !human(node) ||
      !human(parent) ||
      node.sender === parent.sender ||
      node.timestamp < parent.timestamp ||
      node.timestamp > options.cutoff
    )
      continue
    if (selectedAnswerers.size && !selectedAnswerers.has(personKey(node))) continue
    const first = answers.get(parent.pk)
    if (
      !first ||
      node.timestamp < first.timestamp ||
      (node.timestamp === first.timestamp && locator(node) < locator(first))
    )
      answers.set(parent.pk, node)
  }
  const eligible = questions.filter((node) => {
    if (node.timestamp > options.cutoff) {
      summary.excludedFuture++
      return false
    }
    return true
  })
  summary.questions = eligible.length
  summary.answered = eligible.filter((node) => answers.has(node.pk)).length
  summary.noObservedAnswer = summary.questions - summary.answered
  const items: AdminRow[] = []
  const evidence = new Map<string, AdminContribution[]>()
  const put = (row: AdminRow, contributions: AdminContribution[]) => {
    items.push(row)
    evidence.set(adminEntityKey(row), contributions)
  }
  if (options.report === "unanswered") {
    for (const node of eligible) {
      check()
      if (answers.has(node.pk) || options.cutoff - node.timestamp < options.olderThan) continue
      put(
        {
          id: locator(node),
          account: node.account,
          chatId: node.chatId,
          message: locator(node),
          ageMilliseconds: options.cutoff - node.timestamp,
          status: "no-observed-answer",
        },
        [{ pk: node.pk, contribution: null }],
      )
    }
    items.sort((a, b) => (b.ageMilliseconds ?? 0) - (a.ageMilliseconds ?? 0) || a.id.localeCompare(b.id))
  } else if (options.report === "responses") {
    const grouped = new Map<string, AdminContribution[]>()
    for (const node of eligible) {
      check()
      const answer = answers.get(node.pk)
      if (!answer) continue
      const key = personKey(answer),
        list = grouped.get(key) ?? []
      list.push({ pk: answer.pk, related: node.pk, contribution: answer.timestamp - node.timestamp })
      grouped.set(key, list)
    }
    for (const person of options.answerers) {
      const rows = grouped.get(personKey({ account: person, sender: person.id })) ?? []
      put(
        {
          id: person.id,
          account: { provider: person.provider, account: person.account },
          questions: eligible.filter(
            (node) => node.account.provider === person.provider && node.account.account === person.account,
          ).length,
          answered: rows.length,
          ...stats(rows.map((row) => row.contribution as number)),
          status: "observed",
        },
        rows,
      )
    }
    items.sort(
      (a, b) =>
        (a.medianMilliseconds ?? Number.POSITIVE_INFINITY) - (b.medianMilliseconds ?? Number.POSITIVE_INFINITY) ||
        adminEntityKey(a).localeCompare(adminEntityKey(b)),
    )
  } else if (options.report === "newcomers") {
    const grouped = new Map<string, AdminNode[]>()
    for (const node of eligible) {
      const key = JSON.stringify([personKey(node), node.chatId])
      const list = grouped.get(key) ?? []
      list.push(node)
      grouped.set(key, list)
    }
    for (const stay of stays) {
      check()
      if (stay.joinedAt === null) {
        if (stay.firstSeenAt >= options.joinSince && stay.firstSeenAt <= options.joinUntil) summary.unknownJoin++
        continue
      }
      if (stay.joinedAt < options.joinSince || stay.joinedAt > options.joinUntil || stay.joinedAt > options.cutoff)
        continue
      const end = Math.min(stay.joinedAt + options.within, stay.goneAt ?? Number.POSITIVE_INFINITY)
      const held = (
        grouped.get(JSON.stringify([personKey({ account: stay.account, sender: stay.id }), stay.chatId])) ?? []
      ).filter((node) => {
        check()
        return node.timestamp >= (stay.joinedAt as number) && node.timestamp < end
      })
      const contributions = held.map((node) => {
        const answer = answers.get(node.pk)
        return {
          pk: node.pk,
          ...(answer && answer.timestamp < end
            ? { related: answer.pk, contribution: answer.timestamp - node.timestamp }
            : { contribution: null }),
        }
      })
      const delays = contributions.flatMap((one) => (one.contribution === null ? [] : [one.contribution]))
      put(
        {
          id: `stay:${createHash("sha256")
            .update(JSON.stringify([stay.account, stay.chatId, stay.id, stay.joinedAt, stay.firstSeenAt]))
            .digest("hex")}`,
          personId: stay.id,
          account: stay.account,
          chatId: stay.chatId,
          joinedAt: new Date(stay.joinedAt).toISOString(),
          windowEnd: new Date(end).toISOString(),
          pending: end > options.cutoff,
          questions: held.length,
          answered: delays.length,
          ...stats(delays),
          status: "partial",
        },
        contributions,
      )
    }
    items.sort(
      (a, b) =>
        (a.joinedAt ?? "").localeCompare(b.joinedAt ?? "") || adminEntityKey(a).localeCompare(adminEntityKey(b)),
    )
  } else {
    const replies = new Map<number, AdminContribution[]>()
    for (const [child, parent] of graph.parents) {
      const node = byPk.get(child)
      if (!node || node.timestamp > options.cutoff) continue
      const list = replies.get(parent) ?? []
      list.push({ pk: child, related: parent, contribution: 1 })
      replies.set(parent, list)
    }
    for (const node of nodes.filter(
      (one) =>
        one.selected &&
        one.chatKind === "channel" &&
        one.graph?.reply === null &&
        !one.graph.discussionSource &&
        one.timestamp <= options.cutoff,
    )) {
      check()
      if (node.views === null) {
        summary.missingViews++
        continue
      }
      const contributions = replies.get(node.pk) ?? []
      if (node.views < options.minViews || contributions.length > options.maxReplies) continue
      put(
        {
          id: locator(node),
          account: node.account,
          chatId: node.chatId,
          message: locator(node),
          views: node.views,
          observedReplies: contributions.length,
          commentSnapshot: node.comments,
          status: graph.quality.complete ? "partial" : "unknown",
        },
        [{ pk: node.pk, contribution: node.views }, ...contributions],
      )
    }
    items.sort((a, b) => (b.views ?? 0) - (a.views ?? 0) || a.id.localeCompare(b.id))
  }
  return { items, evidence, summary, graph: graph.quality }
}
