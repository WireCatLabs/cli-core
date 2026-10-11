import { CliError } from "@wirecat/cli-base"
import { rankingQuestion } from "./rankings-options.js"

export interface RankingGraphLink {
  chatId: string
  messageId: string
}
export interface RankingGraphEvidence {
  version: 1
  reply?: RankingGraphLink | null
  discussionChatId?: string
  discussionSource?: RankingGraphLink
}
export interface RankingGraphNode {
  pk: number
  account: { provider: string; account: string }
  chatId: string
  id: string
  chatKind: string
  sender: string | null
  senderIsChat?: boolean
  timestamp: number
  text: string
  event: boolean
  selected: boolean
  graph?: RankingGraphEvidence
}
export interface RankingGraphRow {
  kind: "posts" | "comments" | "bridge" | "other" | null
  replies: number
  selfReplies: number
  otherReplies: number
  descendants: number
  thread: number
  answerFor: number | null
  answerDelay: number | null
}
export const RANKING_GRAPH_LIMITS = { nodes: 50_000, depth: 256, work: 10_000_000, bytes: 8_388_608 } as const
const exhausted = (budget: string): never => {
  throw new CliError("validation_error", `ranking exceeded ${budget} — narrow its chat or date scope`, {
    reason: "query_limit",
    budget,
    complete: false,
  })
}
const key = (node: Pick<RankingGraphNode, "account" | "chatId" | "id">) =>
  JSON.stringify([node.account.provider, node.account.account, node.chatId, node.id])
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const link = (value: unknown): RankingGraphLink | undefined => {
  const fields = record(value)
  if (
    !fields ||
    typeof fields.chatId !== "string" ||
    typeof fields.messageId !== "string" ||
    !fields.chatId ||
    !fields.messageId ||
    fields.chatId.length > 256 ||
    fields.messageId.length > 256
  )
    return undefined
  return { chatId: fields.chatId, messageId: fields.messageId }
}
/** Only explicit versioned linkage participates; old thread ids and ordinary forwards do not. */
export const rankingGraphEvidence = (value: unknown): RankingGraphEvidence | undefined => {
  const fields = record(value)
  if (fields?.version !== 1) return undefined
  const reply = fields.reply === null ? null : link(fields.reply)
  const source = link(fields.discussionSource)
  const discussion =
    typeof fields.discussionChatId === "string" &&
    fields.discussionChatId.length > 0 &&
    fields.discussionChatId.length <= 256
      ? fields.discussionChatId
      : undefined
  return {
    version: 1,
    ...(reply === undefined ? {} : { reply }),
    ...(source === undefined ? {} : { discussionSource: source }),
    ...(discussion === undefined ? {} : { discussionChatId: discussion }),
  }
}

/** The caller supplies a bounded, authorised graph, including structural ancestors outside the event period. */
export const rankReplyGraph = (nodes: readonly RankingGraphNode[], check: () => void = () => {}) => {
  if (nodes.length > RANKING_GRAPH_LIMITS.nodes) exhausted("reply graph nodes")
  const byKey = new Map<string, RankingGraphNode>()
  const byPk = new Map<number, RankingGraphNode>()
  const questions = new Set<number>()
  let bytes = 0
  for (const node of nodes) {
    check()
    bytes += Buffer.byteLength(node.text) + Buffer.byteLength(JSON.stringify(node.graph ?? null))
    if (bytes > RANKING_GRAPH_LIMITS.bytes) exhausted("reply graph bytes")
    if (byKey.has(key(node)) || byPk.has(node.pk)) throw new Error("ranking graph contains duplicate message keys")
    if (node.event && rankingQuestion(node.text)) questions.add(node.pk)
    byKey.set(key(node), node)
    byPk.set(node.pk, node)
  }
  const accountQuality = new Map<
    string,
    {
      account: RankingGraphNode["account"]
      unknownLinks: number
      unknownAuthors: number
      missingParents: number
      cycles: number
      complete: boolean
    }
  >()
  const qualityFor = (node: RankingGraphNode) => {
    const accountKey = JSON.stringify([node.account.provider, node.account.account])
    let quality = accountQuality.get(accountKey)
    if (!quality) {
      quality = {
        account: node.account,
        unknownLinks: 0,
        unknownAuthors: 0,
        missingParents: 0,
        cycles: 0,
        complete: true,
      }
      accountQuality.set(accountKey, quality)
    }
    return quality
  }
  for (const node of nodes) qualityFor(node)
  let unknownLinks = 0
  let unknownAuthors = 0
  let missingParents = 0
  let cycles = 0
  let work = 0
  const touch = () => {
    check()
    if (++work > RANKING_GRAPH_LIMITS.work) exhausted("reply graph work")
  }
  const originOf = (node: RankingGraphNode): RankingGraphNode | undefined => {
    const source = node.graph?.discussionSource
    if (!source) return undefined
    const origin = byKey.get(key({ account: node.account, chatId: source.chatId, id: source.messageId }))
    return origin?.chatKind === "channel" && origin.graph?.discussionChatId === node.chatId ? origin : undefined
  }
  const parents = new Map<number, number>()
  const result = new Map<number, RankingGraphRow>()
  for (const node of nodes) {
    touch()
    result.set(node.pk, {
      kind: null,
      replies: 0,
      selfReplies: 0,
      otherReplies: 0,
      descendants: 0,
      thread: 0,
      answerFor: null,
      answerDelay: null,
    })
    if (node.graph?.discussionSource) continue
    const reply = node.graph?.reply
    if (reply === undefined) {
      if (node.event) {
        unknownLinks++
        qualityFor(node).unknownLinks++
      }
      continue
    }
    if (reply === null) continue
    let parent = byKey.get(key({ account: node.account, chatId: reply.chatId, id: reply.messageId }))
    if (parent?.graph?.discussionSource) parent = originOf(parent)
    if (!parent) {
      if (node.event) {
        missingParents++
        qualityFor(node).missingParents++
      }
      continue
    }
    parents.set(node.pk, parent.pk)
  }
  const answers = new Map<number, RankingGraphNode>()
  for (const node of nodes) {
    touch()
    const parentPk = parents.get(node.pk)
    const parent = parentPk === undefined ? undefined : byPk.get(parentPk)
    if (node.event && parent && parent.pk !== node.pk) {
      const row = result.get(parent.pk) as RankingGraphRow
      row.replies++
      if (node.sender === null || parent.sender === null) {
        unknownAuthors++
        qualityFor(node).unknownAuthors++
      } else if (node.sender === parent.sender && Boolean(node.senderIsChat) === Boolean(parent.senderIsChat))
        row.selfReplies++
      else if (!node.senderIsChat) {
        row.otherReplies++
        if (!parent.senderIsChat && parent.event && questions.has(parent.pk) && node.timestamp >= parent.timestamp) {
          const first = answers.get(parent.pk)
          if (
            !first ||
            node.timestamp < first.timestamp ||
            (node.timestamp === first.timestamp && key(node) < key(first))
          )
            answers.set(parent.pk, node)
        }
      }
    }
    const visited = new Set<number>([node.pk])
    let current: RankingGraphNode | undefined = node
    let depth = 0
    while (current) {
      touch()
      if (++depth > RANKING_GRAPH_LIMITS.depth) exhausted("reply graph depth")
      const row = result.get(node.pk) as RankingGraphRow
      if (!["group", "channel"].includes(current.chatKind)) {
        row.kind = "other"
        break
      }
      if (current.graph?.discussionSource) {
        row.kind = current.pk === node.pk ? "bridge" : originOf(current) ? "comments" : null
        break
      }
      if (current.chatKind === "channel" || (current.chatKind === "group" && current.graph?.reply === null)) {
        row.kind = current.pk === node.pk ? "posts" : "comments"
        break
      }
      const ancestorPk = parents.get(current.pk)
      if (ancestorPk === undefined) break
      if (visited.has(ancestorPk)) {
        if (node.event) {
          cycles++
          qualityFor(node).cycles++
        }
        break
      }
      visited.add(ancestorPk)
      current = byPk.get(ancestorPk)
    }
    if (!node.event || node.graph?.discussionSource) continue
    const counted = new Set<number>([node.pk])
    let ancestor = parents.get(node.pk)
    let depthCount = 0
    while (ancestor !== undefined && !counted.has(ancestor)) {
      touch()
      if (++depthCount > RANKING_GRAPH_LIMITS.depth) exhausted("reply graph depth")
      counted.add(ancestor)
      const row = result.get(ancestor) as RankingGraphRow
      row.descendants++
      ancestor = parents.get(ancestor)
    }
  }
  for (const [question, answer] of answers) {
    if (!answer.selected) continue
    const row = result.get(answer.pk) as RankingGraphRow
    row.answerFor = question
    row.answerDelay = answer.timestamp - (byPk.get(question) as RankingGraphNode).timestamp
  }
  for (const node of nodes) {
    const row = result.get(node.pk) as RankingGraphRow
    row.thread =
      node.graph?.reply === null && !node.graph?.discussionSource && !parents.has(node.pk) && row.descendants > 0
        ? 1
        : 0
  }
  for (const quality of accountQuality.values())
    quality.complete =
      quality.unknownLinks === 0 && quality.unknownAuthors === 0 && quality.missingParents === 0 && quality.cycles === 0
  return {
    parents,
    accounts: [...accountQuality.values()],
    rows: result,
    quality: {
      unknownLinks,
      unknownAuthors,
      missingParents,
      cycles,
      complete: unknownLinks === 0 && unknownAuthors === 0 && missingParents === 0 && cycles === 0,
    },
  }
}
