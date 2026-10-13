import type {
  RankedEvidence,
  RankingEvidenceItem,
  RankingEvidenceRequest,
} from "../contracts/ranking-evidence-types.js"

export type {
  EvidenceTarget,
  RankedEvidence,
  RankingEvidenceItem,
  RankingEvidenceRequest,
} from "../contracts/ranking-evidence-types.js"

import { createHash } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import { formatLocator } from "../../domain/locator.js"
import type { QueryExecution } from "../../search/lucene/resolved.js"
import type { SqlValue } from "../driver.js"
import { counterStates } from "./counters.js"
import type { StoreContext } from "./open.js"
import { rankingCounter, rankQuery } from "./rankings.js"
import { hitsByPk } from "./search.js"

const EVIDENCE_BYTES = 64 * 1024
const FINGERPRINT_BYTES = 8 * 1024 * 1024
function fail(message: string, reason: string): never {
  throw new CliError("validation_error", message, { reason, complete: false })
}

export const rankingEvidence = (
  context: StoreContext,
  execution: QueryExecution,
  request: RankingEvidenceRequest,
): RankedEvidence => {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100)
    fail("evidence limit must be 1–100", "query.invalid-limit")
  if (
    !(request.options.components as readonly string[]).includes(request.component) &&
    !(request.options.target === "contacts" && request.component === "messages")
  )
    fail("component is not exposed by this ranking selection", "invalid_component")
  let result: RankedEvidence | undefined
  rankQuery(context, execution, request, ({ prefix, params, filtered, check }) => {
    const { database } = context
    const { target, component } = request
    const identity =
      request.options.target === "messages"
        ? "provider=? AND account=? AND chat=? AND id=?"
        : "provider=? AND account=? AND id=?"
    const identityParams: SqlValue[] = [
      target.account.provider,
      target.account.account,
      ...(request.options.target === "messages" ? [target.chatId ?? ""] : []),
      target.id,
    ]
    const ranked = database
      .prepare(`${prefix}SELECT * FROM eligible WHERE ${identity}`)
      .get(...params, ...identityParams)
    if (!ranked)
      throw new CliError("not_found", "ranking row is no longer eligible in this selection — run stats top again", {
        reason: "selection.changed",
      })
    const targetSql = `${filtered} AND ac.provider=? AND ac.external_id=? AND ${request.options.target === "messages" ? "c.external_id=? AND m.external_id=?" : "i.external_id=?"}`
    const targetParams = [...params, ...identityParams]
    const roots = `target_messages AS (SELECT m.id ${targetSql})`
    let source = "SELECT id AS id,NULL AS related,NULL AS contribution FROM target_messages"
    if (["replies", "replies-from-others", "replies-from-others-per-message"].includes(component)) {
      source = `SELECT g.id AS id,g.parent AS related,1 AS contribution FROM ranking_graph g JOIN ranking_graph parent ON parent.id=g.parent WHERE g.event=1 AND g.id<>g.parent AND g.parent IN (SELECT id FROM target_messages)${component === "replies" ? "" : " AND g.sender IS NOT NULL AND g.sender_chat=0 AND parent.sender IS NOT NULL AND (parent.sender<>g.sender OR parent.sender_chat<>g.sender_chat)"}`
    } else if (["answers", "answer-time"].includes(component)) {
      source = `SELECT d.id AS id,d.answer_for AS related,${component === "answers" ? "1" : "d.delay"} AS contribution FROM ranking_derived d WHERE d.id IN (SELECT id FROM target_messages) AND d.answer_for IS NOT NULL`
    } else if (component === "threads") {
      source =
        "SELECT d.id AS id,NULL AS related,1 AS contribution FROM ranking_derived d WHERE d.id IN (SELECT id FROM target_messages) AND d.thread=1"
    } else if (component === "thread-size") {
      source = `WITH RECURSIVE descendants(root,id,path) AS (
        SELECT g.parent,g.id,'/'||g.parent||'/'||g.id||'/' FROM ranking_graph g WHERE g.parent IN (SELECT id FROM target_messages) AND g.id<>g.parent
        UNION ALL SELECT d.root,g.id,d.path||g.id||'/' FROM descendants d JOIN ranking_graph g ON g.parent=d.id WHERE instr(d.path,'/'||g.id||'/')=0 LIMIT 50001)
        SELECT DISTINCT d.id,d.root AS related,1 AS contribution FROM descendants d JOIN ranking_graph g ON g.id=d.id WHERE g.event=1 AND coalesce(g.kind,'')<>'bridge'`
    } else if (component === "words")
      source =
        "SELECT d.id AS id,NULL AS related,d.words AS contribution FROM ranking_derived d WHERE d.id IN (SELECT id FROM target_messages)"
    else if (component === "active-days" || component === "messages")
      source = "SELECT id AS id,NULL AS related,1 AS contribution FROM target_messages"
    else if (["reactions", "reactions-per-message"].includes(component))
      source = `SELECT m.id AS id,NULL AS related,${rankingCounter("m", "reactions", true)} AS contribution FROM messages m WHERE m.id IN (SELECT id FROM target_messages)`
    else
      source = `SELECT m.id AS id,NULL AS related,${rankingCounter("m", component)} AS contribution FROM messages m WHERE m.id IN (SELECT id FROM target_messages)`
    const rows = `WITH ${roots},evidence AS (${source}) SELECT e.id AS pk,e.related,e.contribution,m.text,m.reactions,m.metadata,m.edited_at,m.sent_at,ac.provider,ac.external_id AS account,c.external_id AS chat,m.external_id AS id,(SELECT json_group_array(json_object('counter',counter,'value',value,'at',created_at,'source',source)) FROM message_counter_observations WHERE message_id=m.id) AS counter_observations,(SELECT json_group_array(json_object('counter',counter,'value',value,'at',created_at,'source',source)) FROM message_counter_observations WHERE message_id=q.id) AS related_counter_observations,q.text AS related_text,q.reactions AS related_reactions,q.metadata AS related_metadata,q.edited_at AS related_edited_at,
      (SELECT json_group_array(json_object('kind',att.kind,'name',att.name,'mime',att.mime,'size',att.size,'url',att.url,'ref',att.provider_ref,'local',att.local_path)) FROM attachments att WHERE att.attachable_type='message' AND att.attachable_id=m.id) AS files,
      (SELECT json_group_array(json_object('kind',att.kind,'name',att.name,'mime',att.mime,'size',att.size,'url',att.url,'ref',att.provider_ref,'local',att.local_path)) FROM attachments att WHERE att.attachable_type='message' AND att.attachable_id=q.id) AS related_files
      FROM evidence e JOIN messages m ON m.id=e.id JOIN chats c ON c.id=m.chat_id JOIN accounts ac ON ac.id=m.account_id LEFT JOIN messages q ON q.id=e.related`
    const size = database
      .prepare(
        `SELECT count(*) AS n,sum(coalesce(length(cast(text AS BLOB)),0)+coalesce(length(cast(reactions AS BLOB)),0)+coalesce(length(cast(metadata AS BLOB)),0)+coalesce(length(cast(edited_at AS BLOB)),0)+coalesce(length(cast(related_text AS BLOB)),0)+coalesce(length(cast(related_reactions AS BLOB)),0)+coalesce(length(cast(related_metadata AS BLOB)),0)+coalesce(length(cast(related_edited_at AS BLOB)),0)+coalesce(length(cast(files AS BLOB)),0)+coalesce(length(cast(related_files AS BLOB)),0)) AS bytes FROM (${rows})`,
      )
      .get(...targetParams)
    const total = Number(size?.n ?? 0)
    if (total > 50_000 || Number(size?.bytes ?? 0) > FINGERPRINT_BYTES)
      fail("evidence exceeds its fingerprint budget — narrow chat/date scope", "query.too-large")
    const ordered = `${rows} ORDER BY m.sent_at,ac.provider,ac.external_id,c.external_id,m.external_id`
    const seed = JSON.stringify([
      execution.root,
      execution.accounts,
      request.options,
      target,
      component,
      request.timezone,
    ])
    let fingerprintBytes = Buffer.byteLength(seed)
    const hash = createHash("sha256").update(seed)
    const page = database.prepare(`${ordered} LIMIT 500 OFFSET ?`)
    for (let offset = 0; offset < total; offset += 500) {
      check()
      for (const row of page.all(...targetParams, offset)) {
        const serialized = JSON.stringify(row)
        fingerprintBytes += Buffer.byteLength(serialized) + 1
        if (fingerprintBytes > FINGERPRINT_BYTES)
          fail("evidence exceeds its fingerprint budget — narrow chat/date scope", "query.too-large")
        hash.update(serialized).update("\n")
      }
    }
    const fingerprint = hash.digest("hex")
    let offset = 0
    if (request.cursor !== undefined) {
      if (request.cursor.length > 4096) fail("evidence cursor is invalid", "invalid_cursor")
      let cursor: unknown
      try {
        cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"))
      } catch {
        fail("evidence cursor is invalid", "invalid_cursor")
      }
      if (
        !cursor ||
        typeof cursor !== "object" ||
        !("version" in cursor) ||
        cursor.version !== 1 ||
        !("offset" in cursor) ||
        typeof cursor.offset !== "number" ||
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0 ||
        !("fingerprint" in cursor)
      )
        fail("evidence cursor is invalid", "invalid_cursor")
      if (cursor.fingerprint !== fingerprint)
        fail("stored evidence changed — restart without --cursor", "evidence_changed")
      offset = cursor.offset
      if (offset > total) fail("evidence cursor is beyond this selection", "invalid_cursor")
    }
    const selected = database.prepare(`${ordered} LIMIT ? OFFSET ?`).all(...targetParams, request.limit, offset)
    const messages = hitsByPk(
      context,
      selected.flatMap((row) => [Number(row.pk), ...(row.related == null ? [] : [Number(row.related)])]),
    )
    const byLocator = new Map(messages.map((message) => [message.locator, message]))
    const items: RankingEvidenceItem[] = []
    let bytes = 2
    for (const row of selected) {
      check()
      const message = byLocator.get(
        formatLocator({
          provider: String(row.provider),
          account: String(row.account),
          chat: String(row.chat),
          message: String(row.id),
        }),
      )
      if (!message) throw new Error("evidence message disappeared inside its read snapshot")
      const related = row.related == null ? undefined : hitsByPk(context, [Number(row.related)])[0]
      const value = typeof row.contribution === "number" && Number.isFinite(row.contribution) ? row.contribution : null
      const item = {
        message,
        ...(related ? { related } : {}),
        contribution: value,
        counters: counterStates(context, Number(row.pk), context.now(), 86_400_000),
      }
      const added = Buffer.byteLength(JSON.stringify(item)) + (items.length ? 1 : 0)
      if (bytes + added > EVIDENCE_BYTES) break
      bytes += added
      items.push(item)
    }
    if (selected.length > 0 && items.length === 0)
      fail("one evidence row exceeds 64 KiB — use messages show for that locator", "evidence.row-too-large")
    const next = offset + items.length
    result = {
      items,
      total,
      included: items.length,
      hasMore: next < total,
      nextCursor:
        next < total
          ? Buffer.from(JSON.stringify({ version: 1, offset: next, fingerprint })).toString("base64url")
          : null,
      fingerprint,
      component,
      componentValue: typeof ranked[component] === "number" ? Number(ranked[component]) : null,
      byteLimit: EVIDENCE_BYTES,
    }
  })
  if (!result) throw new CliError("not_found", "ranking selection has no matching row")
  return result
}
