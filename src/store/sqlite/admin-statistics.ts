import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import {
  type AdminNode,
  type AdminOptions,
  type AdminRow,
  type AdminStay,
  adminEntityKey,
  calculateAdminStatistics,
} from "../../domain/admin-statistics.js"
import { type CounterState, counterFreshness } from "../../domain/counters.js"
import { RANKING_GRAPH_LIMITS, rankingGraphEvidence } from "../../domain/rankings-graph.js"
import type { QueryExecution } from "../../search/lucene/resolved.js"
import type { SqlValue } from "../driver.js"
import type { StoredHit } from "../store.js"
import { chatCompleteness } from "./completeness.js"
import { counterStates } from "./counters.js"
import { withQuerySelection } from "./lucene.js"
import type { StoreContext } from "./open.js"
import { rankingCounter } from "./rankings.js"
import { hitsByPk } from "./search.js"

export interface AdminStoreRequest {
  options: AdminOptions
  evidence?: { entity: { account: { provider: string; account: string }; id: string }; cursor?: string }
}
export interface AdminEvidenceItem {
  message: StoredHit
  related?: StoredHit
  contribution: number | null
  counters?: CounterState[]
}
export interface AdminStoreResult {
  items: AdminRow[]
  total: number
  included: number
  hasMore: boolean
  cutoff: string
  summary: ReturnType<typeof calculateAdminStatistics>["summary"]
  quality: {
    graph: ReturnType<typeof calculateAdminStatistics>["graph"]
    archives: {
      account: { provider: string; account: string }
      chatId: string
      state: string
      fetchedAt: string | null
    }[]
    membership: "observed_stays_only" | "not_used"
    archivesTotal: number
    counterFreshness: "fresh" | "stale" | "partial" | "unknown"
    answererRoles: "user_selected_identities"
  }
  evidence?: AdminEvidenceItem[]
  nextCursor?: string | null
  fingerprint: string
  byteLimit: number
}
function fail(message: string, reason = "query_limit"): never {
  throw new CliError("validation_error", message, { reason, complete: false })
}
const joined =
  "FROM messages m JOIN chats c ON c.id=m.chat_id JOIN accounts ac ON ac.id=m.account_id LEFT JOIN identities i ON i.id=m.sender_identity_id"
const attachmentSnapshot = `(SELECT json_group_array(json_object('position',position,'kind',kind,'mime',mime,'name',name,'title',title,'url',url,'size',size,'width',width,'height',height,'duration',duration,'providerRef',provider_ref,'localPath',local_path)) FROM attachments WHERE attachable_type='message' AND attachable_id=m.id)`
const snapshot = `json_object('edited',m.edited_at,'senderName',m.sender_name,'reply',m.reply_to,'forward',m.forward,'reactions',m.reactions,'outgoing',m.outgoing,'thread',m.thread_external_id,'attachments',${attachmentSnapshot},'counterObservations',(SELECT json_group_array(json_object('counter',counter,'value',value,'at',created_at,'source',source)) FROM message_counter_observations WHERE message_id=m.id))`

export const adminStatisticsQuery = (
  context: StoreContext,
  execution: QueryExecution,
  request: AdminStoreRequest,
): AdminStoreResult =>
  withQuerySelection(context, execution, (selection, check) => {
    const { database } = context,
      { options } = request
    const prefix = `WITH selected AS (${selection.sql}) `
    const root = database
      .prepare(
        `${prefix}SELECT min(m.sent_at) AS oldest,count(*) AS total ${joined} WHERE m.id IN (SELECT id FROM selected)`,
      )
      .get(...selection.params)
    const lower = options.report === "newcomers" ? options.joinSince : Number(root?.oldest ?? options.cutoff)
    const params: SqlValue[] = execution.accounts.flatMap((account) => [account.provider, account.account])
    let scope = `(${execution.accounts.map(() => "(ac.provider=? AND ac.external_id=?)").join(" OR ") || "0"})`
    if (execution.chat) {
      scope += ` AND ac.provider=? AND ac.external_id=? AND (c.external_id=? OR c.external_id IN (SELECT json_extract(CASE WHEN json_valid(post.metadata) THEN post.metadata ELSE '{}' END,'$.graph.discussionChatId') FROM messages post JOIN chats source ON source.id=post.chat_id WHERE post.account_id=ac.id AND source.external_id=? AND source.kind='channel' AND post.deleted_at IS NULL))`
      params.push(
        execution.chat.account.provider,
        execution.chat.account.account,
        execution.chat.chatId,
        execution.chat.chatId,
      )
    } else scope += " AND c.searchable=1"
    const where = `m.deleted_at IS NULL AND ${scope} AND (m.sent_at BETWEEN ? AND ?${options.report === "newcomers" ? "" : " OR m.id IN (SELECT id FROM selected)"})`
    const bound = [...selection.params, ...params, lower, options.cutoff]
    const size = database
      .prepare(
        `${prefix}SELECT count(*) AS n,sum(length(cast(m.text AS BLOB))+length(cast(coalesce(m.metadata,'') AS BLOB))+length(cast(${snapshot} AS BLOB))) AS bytes ${joined} WHERE ${where}`,
      )
      .get(...bound)
    check()
    if (Number(size?.n ?? 0) > RANKING_GRAPH_LIMITS.nodes || Number(size?.bytes ?? 0) > RANKING_GRAPH_LIMITS.bytes)
      fail("admin statistics context exceeds node/byte budgets — narrow chat/date scope")
    const raw = database
      .prepare(
        `${prefix}SELECT m.id AS pk,m.external_id AS id,c.id AS chat_id,ac.id AS account_id,c.external_id AS chat,c.title AS title,c.kind,ac.provider,ac.external_id AS account,i.external_id AS sender,m.sender_chat_external_id AS sender_chat,i.bot,m.sent_at,m.text,m.metadata,${snapshot} AS snapshot,${rankingCounter("m", "views")} AS views,${rankingCounter("m", "comments")} AS comments,m.id IN (SELECT id FROM selected) AS selected ${joined} WHERE ${where} ORDER BY m.id`,
      )
      .all(...bound)
    const nodes: AdminNode[] = raw.map((row) => {
      let metadata: Record<string, unknown> = {}
      try {
        const value: unknown = JSON.parse(String(row.metadata ?? "{}"))
        if (value && typeof value === "object") metadata = value as Record<string, unknown>
      } catch {
        /* Invalid metadata remains unknown. */
      }
      const graph = rankingGraphEvidence(metadata.graph)
      return {
        pk: Number(row.pk),
        id: String(row.id),
        account: { provider: String(row.provider), account: String(row.account) },
        chatId: String(row.chat),
        chatKind: String(row.kind),
        sender: row.sender === null ? null : String(row.sender),
        senderIsChat: row.sender_chat !== null,
        timestamp: Number(row.sent_at),
        text: String(row.text),
        selected: Number(row.selected) === 1,
        event: Number(row.sent_at) <= options.cutoff,
        ...(graph ? { graph } : {}),
        views: row.views === null ? null : Number(row.views),
        comments: row.comments === null ? null : Number(row.comments),
        bot: Number(row.bot) === 1,
      }
    })
    let stays: AdminStay[] = []
    if (options.report === "newcomers" && execution.chat) {
      const chat = execution.chat
      const records = database
        .prepare(
          "SELECT i.external_id AS id,s.joined_at,s.first_seen_at,s.left_at FROM member_stays s JOIN identities i ON i.id=s.identity_id JOIN chats c ON c.id=s.chat_id JOIN accounts ac ON ac.id=c.account_id WHERE ac.provider=? AND ac.external_id=? AND c.external_id=? AND ((s.joined_at BETWEEN ? AND ?) OR (s.joined_at IS NULL AND s.first_seen_at BETWEEN ? AND ?)) ORDER BY s.id LIMIT ?",
        )
        .all(
          chat.account.provider,
          chat.account.account,
          chat.chatId,
          options.joinSince,
          options.joinUntil,
          options.joinSince,
          options.joinUntil,
          RANKING_GRAPH_LIMITS.nodes + 1,
        )
      if (records.length > RANKING_GRAPH_LIMITS.nodes) fail("newcomer cohort exceeds node budget — narrow join dates")
      stays = records.map((row) => ({
        id: String(row.id),
        account: chat.account,
        chatId: chat.chatId,
        joinedAt: row.joined_at === null ? null : Number(row.joined_at),
        firstSeenAt: Number(row.first_seen_at),
        goneAt: row.left_at === null ? null : Number(row.left_at),
      }))
    }
    const serialized = JSON.stringify({
      rows: raw,
      stays,
      execution: { root: execution.root, accounts: execution.accounts, chat: execution.chat },
      options,
    })
    if (Buffer.byteLength(serialized) > RANKING_GRAPH_LIMITS.bytes)
      fail("admin statistics serialized fingerprint exceeds 8 MiB — narrow scope")
    const fingerprint = createHash("sha256").update(serialized).digest("hex")
    const calculated = calculateAdminStatistics(nodes, stays, options, check)
    const archives: AdminStoreResult["quality"]["archives"] = []
    const seen = new Set<number>()
    for (const row of raw) {
      const pk = Number(row.chat_id)
      if (seen.has(pk)) continue
      seen.add(pk)
      check()
      if (archives.length >= 100) continue
      const complete = chatCompleteness(context, Number(row.account_id), [String(row.chat)])[0]
      archives.push({
        account: { provider: String(row.provider), account: String(row.account) },
        chatId: String(row.chat),
        state: complete?.state ?? "unknown",
        fetchedAt: complete?.fetchedAt ?? null,
      })
    }
    const reportItems = calculated.items.slice(0, execution.limit).map((item) => {
      const node = nodes.find(
        (one) =>
          item.message ===
          `msg:${[one.account.provider, one.account.account, one.chatId, one.id].map(encodeURIComponent).join("/")}`,
      )
      return node ? { ...item, counterObservations: counterStates(context, node.pk, context.now(), 86_400_000) } : item
    })
    const result: AdminStoreResult = {
      items: reportItems,
      total: calculated.items.length,
      included: Math.min(execution.limit, calculated.items.length),
      hasMore: calculated.items.length > execution.limit,
      cutoff: new Date(options.cutoff).toISOString(),
      summary: calculated.summary,
      quality: {
        graph: calculated.graph,
        archives,
        archivesTotal: seen.size,
        membership: options.report === "newcomers" ? "observed_stays_only" : "not_used",
        counterFreshness:
          options.report === "discussion"
            ? counterFreshness(
                reportItems.flatMap((item) =>
                  (item.counterObservations ?? []).filter(
                    (state) => state.counter === "views" || state.counter === "comments",
                  ),
                ),
              )
            : "unknown",
        answererRoles: "user_selected_identities",
      },
      fingerprint,
      byteLimit: 64 * 1024,
    }
    if (request.evidence) {
      const rows = calculated.evidence.get(adminEntityKey(request.evidence.entity))
      if (!rows) fail("report row is no longer eligible — rerun its report", "selection_changed")
      let offset = 0
      if (request.evidence.cursor) {
        if (request.evidence.cursor.length > 4096) fail("invalid evidence cursor", "invalid_cursor")
        try {
          const cursor = JSON.parse(Buffer.from(request.evidence.cursor, "base64url").toString()) as {
            offset: number
            fingerprint: string
            entity: string
          }
          if (
            !Number.isSafeInteger(cursor.offset) ||
            cursor.offset < 0 ||
            cursor.offset > rows.length ||
            cursor.fingerprint !== fingerprint ||
            cursor.entity !== adminEntityKey(request.evidence.entity)
          )
            fail("stored evidence changed — restart the report", "selection_changed")
          offset = cursor.offset
        } catch (error) {
          if (error instanceof CliError) throw error
          fail("invalid evidence cursor", "invalid_cursor")
        }
      }
      const evidence: AdminEvidenceItem[] = []
      let bytes = 2
      for (const row of rows.slice(offset, offset + execution.limit)) {
        check()
        const pks = [row.pk, ...(row.related === undefined ? [] : [row.related])]
        const hits = hitsByPk(context, pks),
          message = hits[0]
        if (!message) fail("report evidence changed — rerun its report", "selection_changed")
        const item = {
          message,
          counters: counterStates(context, row.pk, context.now(), 86_400_000),
          ...(row.related === undefined ? {} : { related: hits[1] }),
          contribution: row.contribution,
        }
        const size = Buffer.byteLength(JSON.stringify(item)) + 1
        if (bytes + size > 64 * 1024) {
          if (!evidence.length)
            fail("one evidence item exceeds 64 KiB — open its message locator", "evidence_item_too_large")
          break
        }
        evidence.push(item)
        bytes += size
      }
      const hasMore = offset + evidence.length < rows.length
      result.items = []
      result.evidence = evidence
      result.total = rows.length
      result.included = evidence.length
      result.hasMore = hasMore
      result.nextCursor = hasMore
        ? Buffer.from(
            JSON.stringify({
              offset: offset + evidence.length,
              fingerprint,
              entity: adminEntityKey(request.evidence.entity),
            }),
          ).toString("base64url")
        : null
    }
    check()
    return result
  })
