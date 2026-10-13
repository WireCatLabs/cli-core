import { CliError } from "@wirecat/cli-base"
import type { CounterState } from "../../domain/counters.js"
import {
  RANKING_GRAPH_LIMITS,
  type RankingGraphNode,
  rankingGraphEvidence,
  rankReplyGraph,
} from "../../domain/rankings-graph.js"
import {
  needsRankingContext,
  type RankingComponent,
  type RankingOptions,
  rankingScore,
  rankingWords,
  type ScoreComponents,
} from "../../domain/rankings-options.js"
import { rankingContextRange } from "../../domain/rankings-range.js"
import type { DateRange } from "../../search/lucene/dates.js"
import type { QueryExecution } from "../../search/lucene/resolved.js"
import type { SqlValue } from "../driver.js"
import { counterStates } from "./counters.js"
import { withQuerySelection } from "./lucene.js"
import type { StoreContext } from "./open.js"

export interface RankingRequest {
  options: RankingOptions
  timezone: string
  contextChat?: QueryExecution["chat"]
}
export interface RankedStoreRow {
  provider: string
  account: string
  id: string
  chatId: string | null
  name: string | null
  pk: number | null
  kind: string | null
  rank: number
  value: number
  components: Record<string, number | null>
  messages: number
  knownReactions: number
  unknownReactions: number
  score: ScoreComponents | null
  counterObservations?: CounterState[]
  graphComplete?: boolean
}
export interface RankedStoreFound {
  total: number
  population: number
  eligible: number
  excludedMinimum: number
  excludedMissing: number
  excludedUnknownSender: number
  excludedUnknownKind: number
  items: RankedStoreRow[]
  maxima: Partial<Record<RankingComponent, number>>
  hasMore: boolean
  graphQuality?: ReturnType<typeof rankReplyGraph>["quality"]
}
const column = (name: string) => `"${name.replaceAll('"', '""')}"`
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
const metadata = (alias: string) => `CASE WHEN json_valid(${alias}.metadata) THEN ${alias}.metadata ELSE '{}' END`
export const rankingCounter = (alias: string, field: string, reactions = false) => {
  const source = reactions
    ? `CASE WHEN json_valid(${alias}.reactions) THEN ${alias}.reactions ELSE '{}' END`
    : metadata(alias)
  const path = reactions ? "$.total" : `$.${field}`
  const value = `json_extract(${source},'${path}')`
  return `CASE WHEN json_type(${source},'${path}') IN ('integer','real') AND ${value}>=0 AND ${value}<=1.7976931348623157e308 THEN CAST(${value} AS REAL) END`
}
const scopeOf = (execution: QueryExecution, request: RankingRequest) => {
  const params: SqlValue[] = execution.accounts.flatMap(({ provider, account }) => [provider, account])
  let sql = `(${execution.accounts.map(() => "(ac.provider=? AND ac.external_id=?)").join(" OR ") || "0"})`
  const chat = request.contextChat ?? execution.chat
  if (chat) {
    sql += ` AND ac.provider=? AND ac.external_id=? AND (c.external_id=? OR c.external_id IN (
      SELECT json_extract(${metadata("post")},'$.graph.discussionChatId') FROM messages post
      JOIN chats source ON source.id=post.chat_id WHERE post.account_id=ac.id AND source.external_id=? AND source.kind='channel' AND json_extract(${metadata("post")},'$.graph.version')=1 AND json_type(${metadata("post")},'$.graph.discussionChatId')='text' AND post.deleted_at IS NULL))`
    params.push(chat.account.provider, chat.account.account, chat.chatId, chat.chatId)
  } else sql += " AND c.searchable=1"
  return { sql, params }
}
const periodOf = (range: DateRange | undefined) => {
  const clauses: string[] = []
  const params: SqlValue[] = []
  if (range?.lower !== undefined) {
    clauses.push(`m.sent_at ${range.lowerInclusive ? ">=" : ">"} ?`)
    params.push(range.lower)
  }
  if (range?.upper !== undefined) {
    clauses.push(`m.sent_at ${range.upperInclusive ? "<=" : "<"} ?`)
    params.push(range.upper)
  }
  return { sql: clauses.join(" AND ") || "1", params }
}
const joined =
  "FROM messages m JOIN chats c ON c.id=m.chat_id JOIN accounts ac ON ac.id=m.account_id LEFT JOIN identities i ON i.id=m.sender_identity_id"
const graphColumns = `m.id AS pk,m.external_id AS id,c.external_id AS chat,ac.provider,ac.external_id AS account,c.kind,
  coalesce(i.external_id,m.sender_chat_external_id) AS sender,m.sender_chat_external_id IS NOT NULL AS sender_chat,
  m.sent_at AS at,${metadata("m")} AS metadata`

const graphIn = (context: StoreContext, execution: QueryExecution, request: RankingRequest, check: () => void) => {
  const { database } = context
  const scope = scopeOf(execution, request)
  const period = periodOf(rankingContextRange(execution.root))
  const where = `m.deleted_at IS NULL AND ${scope.sql} AND (${period.sql} OR m.id IN (SELECT id FROM ranking_selected))`
  const params = [...scope.params, ...period.params]
  const questions = request.options.components.some((name) => ["answers", "answer-time"].includes(name))
  const body = questions ? "m.text" : "''"
  const size = database
    .prepare(
      `SELECT count(*) AS n,sum(length(cast(${body} AS BLOB))+length(cast(${metadata("m")} AS BLOB))) AS bytes ${joined} WHERE ${where}`,
    )
    .get(...params)
  check()
  if (Number(size?.n ?? 0) > RANKING_GRAPH_LIMITS.nodes || Number(size?.bytes ?? 0) > RANKING_GRAPH_LIMITS.bytes)
    throw new CliError(
      "validation_error",
      "ranking reply context exceeds its node or byte budget — narrow chat/date scope",
      { reason: "query.too-large", budget: "reply context", complete: false },
    )
  const rows = database
    .prepare(
      `SELECT ${graphColumns},${body} AS text,(${period.sql}) AS event,m.id IN (SELECT id FROM ranking_selected) AS selected ${joined} WHERE ${where}`,
    )
    .all(...period.params, ...params)
  const nodes: RankingGraphNode[] = []
  const keys = new Set<string>()
  const key = (provider: string, account: string, chat: string, id: string) =>
    JSON.stringify([provider, account, chat, id])
  let bytes = 0
  const add = (row: Record<string, unknown>, structural = false) => {
    check()
    bytes += Buffer.byteLength(String(row.text ?? "")) + Buffer.byteLength(String(row.metadata ?? ""))
    if (bytes > RANKING_GRAPH_LIMITS.bytes || nodes.length >= RANKING_GRAPH_LIMITS.nodes)
      throw new CliError("validation_error", "ranking reply ancestors exceed their graph budget", {
        reason: "query.too-large",
        budget: "reply ancestors",
        complete: false,
      })
    const raw: unknown = JSON.parse(String(row.metadata ?? "{}"))
    const graph = rankingGraphEvidence(
      raw !== null && typeof raw === "object" && "graph" in raw ? raw.graph : undefined,
    )
    const node: RankingGraphNode = {
      pk: Number(row.pk),
      account: { provider: String(row.provider), account: String(row.account) },
      chatId: String(row.chat),
      id: String(row.id),
      chatKind: String(row.kind),
      sender: row.sender == null ? null : String(row.sender),
      senderIsChat: Number(row.sender_chat) === 1,
      timestamp: Number(row.at),
      text: structural ? "" : String(row.text),
      event: !structural && Number(row.event) === 1,
      selected: !structural && Number(row.selected) === 1,
      ...(graph ? { graph } : {}),
    }
    keys.add(key(node.account.provider, node.account.account, node.chatId, node.id))
    nodes.push(node)
  }
  for (const row of rows) add(row)
  const missing = new Set<string>()
  const parentQuery = database.prepare(
    `SELECT ${graphColumns} ${joined} WHERE m.deleted_at IS NULL AND ${scope.sql} AND ac.provider=? AND ac.external_id=? AND c.external_id=? AND m.external_id=?`,
  )
  for (let index = 0; index < nodes.length; index++) {
    check()
    const node = nodes[index] as RankingGraphNode
    for (const parent of [node.graph?.reply, node.graph?.discussionSource]) {
      if (!parent) continue
      const wanted = key(node.account.provider, node.account.account, parent.chatId, parent.messageId)
      if (keys.has(wanted) || missing.has(wanted)) continue
      const row = parentQuery.get(
        ...scope.params,
        node.account.provider,
        node.account.account,
        parent.chatId,
        parent.messageId,
      )
      if (row) add(row, true)
      else missing.add(wanted)
    }
  }
  const found = rankReplyGraph(nodes, check)
  const quality = database.prepare(
    "INSERT INTO ranking_quality(account_id,complete) SELECT id AS pk,? FROM accounts WHERE provider=? AND external_id=?",
  )
  for (const account of found.accounts)
    quality.run(account.complete ? 1 : 0, account.account.provider, account.account.account)
  const update = database.prepare(
    "UPDATE ranking_derived SET kind=?,replies=?,others=?,descendants=?,thread=?,answer_for=?,delay=? WHERE id=?",
  )
  const insertGraph = database.prepare(
    "INSERT INTO ranking_graph(id,parent,kind,event,answer_for,delay,sender,sender_chat) VALUES (?,?,?,?,?,?,?,?)",
  )
  for (const node of nodes) {
    const row = found.rows.get(node.pk)
    insertGraph.run(
      node.pk,
      found.parents.get(node.pk) ?? null,
      row?.kind ?? null,
      node.event ? 1 : 0,
      row?.answerFor ?? null,
      row?.answerDelay ?? null,
      node.sender,
      node.senderIsChat ? 1 : 0,
    )
  }
  for (const [pk, row] of found.rows) {
    check()
    update.run(row.kind, row.replies, row.otherReplies, row.descendants, row.thread, row.answerFor, row.answerDelay, pk)
  }
  return found.quality
}

/** Aggregate and normalize the whole population, returning only a bounded page. */
export interface RankingSnapshot {
  prefix: string
  params: SqlValue[]
  filtered: string
  found: RankedStoreFound
  check: () => void
}
export const rankQuery = (
  context: StoreContext,
  execution: QueryExecution,
  request: RankingRequest,
  inspect?: (snapshot: RankingSnapshot) => void,
): RankedStoreFound => {
  if (!Number.isSafeInteger(execution.limit) || execution.limit < 1 || execution.limit > 100)
    throw new CliError("validation_error", "ranking limit must be 1–100")
  return withQuerySelection(context, execution, (selection, check) => {
    const { database } = context
    const { options } = request
    const componentNames = options.components
    database.exec(
      "CREATE TEMP TABLE ranking_selected(id INTEGER PRIMARY KEY); CREATE TEMP TABLE ranking_derived(id INTEGER PRIMARY KEY,words INTEGER,day TEXT,kind TEXT,replies INTEGER,others INTEGER,descendants INTEGER,thread INTEGER,answer_for INTEGER,delay REAL); CREATE TEMP TABLE ranking_quality(account_id INTEGER PRIMARY KEY,complete INTEGER); CREATE TEMP TABLE ranking_graph(id INTEGER PRIMARY KEY,parent INTEGER,kind TEXT,event INTEGER,answer_for INTEGER,delay REAL,sender TEXT,sender_chat INTEGER); CREATE INDEX ranking_graph_parent ON ranking_graph(parent)",
    )
    try {
      database.prepare(`INSERT INTO ranking_selected ${selection.sql}`).run(...selection.params)
      database.exec("INSERT INTO ranking_derived(id) SELECT id FROM ranking_selected")
      const total = Number(database.prepare("SELECT count(*) AS n FROM ranking_selected").get()?.n ?? 0)
      if (total === 0)
        return {
          total: 0,
          population: 0,
          eligible: 0,
          excludedMinimum: 0,
          excludedMissing: 0,
          excludedUnknownSender: 0,
          excludedUnknownKind: 0,
          items: [],
          maxima: {},
          hasMore: false,
        }
      const graph =
        needsRankingContext(options) || options.messageKind === "comments"
          ? graphIn(context, execution, request, check)
          : undefined
      const words = options.components.includes("words")
      const days = options.components.includes("active-days")
      if (words || days) {
        const size = words
          ? Number(
              database
                .prepare(
                  "SELECT sum(length(cast(m.text AS BLOB))) AS bytes FROM ranking_selected s JOIN messages m ON m.id=s.id",
                )
                .get()?.bytes ?? 0,
            )
          : 0
        if (size > RANKING_GRAPH_LIMITS.bytes)
          throw new CliError("validation_error", "ranking word text exceeds its byte budget — narrow chat/date scope", {
            reason: "query.too-large",
            budget: "ranking text",
            complete: false,
          })
        const format = days
          ? new Intl.DateTimeFormat("en-CA", {
              timeZone: request.timezone,
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
            })
          : undefined
        const page = database.prepare(
          `SELECT m.id AS pk,m.sent_at${words ? ",m.text" : ""} FROM ranking_selected s JOIN messages m ON m.id=s.id WHERE s.id>? ORDER BY s.id LIMIT 500`,
        )
        const update = database.prepare("UPDATE ranking_derived SET words=?,day=? WHERE id=?")
        let after = -1
        for (let rows = page.all(after); rows.length; rows = page.all(after)) {
          check()
          for (const row of rows) {
            check()
            const parts = format
              ? Object.fromEntries(format.formatToParts(Number(row.sent_at)).map(({ type, value }) => [type, value]))
              : undefined
            update.run(
              words ? rankingWords(String(row.text)) : null,
              parts ? `${parts.year}-${parts.month}-${parts.day}` : null,
              Number(row.pk),
            )
          }
          after = Number(rows.at(-1)?.pk)
        }
      }
      const graphMeta = metadata("m")
      const kind = graph
        ? "d.kind"
        : `CASE WHEN c.kind='channel' THEN 'posts' WHEN c.kind='group' AND json_extract(${graphMeta},'$.graph.version')=1 AND json_type(${graphMeta},'$.graph.discussionSource')='object' THEN 'bridge' WHEN c.kind='group' AND json_extract(${graphMeta},'$.graph.version')=1 AND json_type(${graphMeta},'$.graph.reply')='null' THEN 'posts' WHEN c.kind NOT IN ('channel','group') THEN 'other' END`
      const reaction = rankingCounter("m", "reactions", true)
      const nonself =
        options.weights !== null ? "CASE WHEN q.complete=1 THEN coalesce(d.others,0) END" : "coalesce(d.others,0)"
      const local = (value: string) =>
        options.weights !== null ? `CASE WHEN q.complete=1 THEN coalesce(${value},0) END` : `coalesce(${value},0)`
      const messageColumns: Record<string, string> = {
        views: rankingCounter("m", "views"),
        reactions: reaction,
        forwards: rankingCounter("m", "forwards"),
        comments: rankingCounter("m", "comments"),
        replies: local("d.replies"),
        "replies-from-others": nonself,
        "thread-size": local("d.descendants"),
      }
      const filtered = `FROM ranking_selected s JOIN messages m ON m.id=s.id JOIN chats c ON c.id=m.chat_id JOIN accounts ac ON ac.id=m.account_id LEFT JOIN identities i ON i.id=m.sender_identity_id LEFT JOIN ranking_derived d ON d.id=m.id LEFT JOIN ranking_quality q ON q.account_id=m.account_id WHERE ${options.messageKind === "all" ? "1" : `${kind}=?`}`
      const params: SqlValue[] = options.messageKind === "all" ? [] : [options.messageKind]
      let raw: string
      if (options.target === "messages")
        raw = `SELECT m.id AS pk,ac.provider,ac.external_id AS account,c.external_id AS chat,m.external_id AS id,m.sender_name AS name,${kind} AS kind,1 AS messages,coalesce(q.complete,0) AS graph_complete,CASE WHEN ${reaction} IS NULL THEN 0 ELSE 1 END AS known_reactions,CASE WHEN ${reaction} IS NULL THEN 1 ELSE 0 END AS unknown_reactions${Object.entries(
          messageColumns,
        )
          .filter(([name]) => componentNames.includes(name as RankingComponent))
          .map(([name, sql]) => `,${sql} AS ${column(name)}`)
          .join("")} ${filtered}`
      else {
        const known = `count(${reaction})`
        const sum = `CASE WHEN ${known}>0 ${options.weights ? `AND ${known}=count(*)` : ""} THEN sum(${reaction}) END`
        const graphKnown = options.weights !== null
        const graphValue = (sql: string) => (graphKnown ? `CASE WHEN max(q.complete)=1 THEN ${sql} END` : sql)
        const kindCondition =
          options.messageKind === "posts"
            ? "AND dd.kind='posts'"
            : options.messageKind === "comments"
              ? "AND dd.kind='comments'"
              : ""
        const authorColumns: Record<string, string> = {
          words: "sum(d.words)",
          reactions: sum,
          replies: graphValue("sum(coalesce(d.replies,0))"),
          "replies-from-others": graphValue("sum(coalesce(d.others,0))"),
          "reactions-per-message": `(${sum})/count(*)`,
          "replies-from-others-per-message": graphValue("sum(coalesce(d.others,0))*1.0/count(*)"),
          answers: graphValue("sum(d.answer_for IS NOT NULL)"),
          threads: graphValue("sum(coalesce(d.thread,0))"),
          "active-days": "count(DISTINCT d.day)",
          "answer-time": `SELECT avg(delay) FROM (SELECT dd.delay,row_number() OVER (ORDER BY dd.delay,mm.external_id) AS position,count(*) OVER () AS n FROM ranking_derived dd JOIN messages mm ON mm.id=dd.id WHERE dd.answer_for IS NOT NULL AND mm.account_id=m.account_id AND mm.sender_identity_id=m.sender_identity_id ${kindCondition}) WHERE position IN ((n+1)/2,(n+2)/2)`,
        }
        raw = `SELECT NULL AS pk,ac.provider,ac.external_id AS account,NULL AS chat,i.external_id AS id,i.name AS name,NULL AS kind,count(*) AS messages,coalesce(max(q.complete),0) AS graph_complete,${known} AS known_reactions,count(*)-${known} AS unknown_reactions${Object.entries(
          authorColumns,
        )
          .filter(([name]) => componentNames.includes(name as RankingComponent))
          .map(([name, sql]) => `,(${sql}) AS ${column(name)}`)
          .join("")} ${filtered} AND m.sender_identity_id IS NOT NULL GROUP BY m.account_id,m.sender_identity_id`
      }
      const present = componentNames
        .map((name) => `${column(name)} IS NOT NULL AND ${column(name)}>=0 AND ${column(name)}<=1.7976931348623157e308`)
        .join(" AND ")
      const minimum = options.target === "contacts" ? `messages>=${options.minMessages}` : "1"
      const prefix = `WITH raw AS MATERIALIZED (${raw}), eligible AS MATERIALIZED (SELECT * FROM raw WHERE ${minimum} AND ${present}) `
      const population = Number(
        database.prepare(`WITH raw AS (${raw}) SELECT count(*) AS n FROM raw`).get(...params)?.n ?? 0,
      )
      const excludedMinimum = Number(
        database.prepare(`WITH raw AS (${raw}) SELECT count(*) AS n FROM raw WHERE NOT (${minimum})`).get(...params)
          ?.n ?? 0,
      )
      const summary = database
        .prepare(
          `${prefix}SELECT count(*) AS n,${componentNames.map((name) => `max(${column(name)}) AS ${column(name)}`).join(",")} FROM eligible`,
        )
        .get(...params)
      const eligible = Number(summary?.n ?? 0)
      const maxima = Object.fromEntries(
        componentNames.filter((name) => name !== "answer-time").map((name) => [name, finite(summary?.[name]) ?? 0]),
      ) as RankedStoreFound["maxima"]
      check()
      let order = `${column(options.measure)} ${options.order === "ascending" ? "ASC" : "DESC"}`
      if (options.weights) {
        const entries = Object.entries(options.weights).filter(([, weight]) => weight > 0) as [
          RankingComponent,
          number,
        ][]
        const scale = Math.max(...entries.map(([, weight]) => weight))
        const denominator = entries.reduce((sum, [, weight]) => sum + weight / scale, 0)
        order = `${entries.map(([name, weight]) => `${weight / scale / denominator} * (${maxima[name] === 0 ? "0" : `${column(name)}*1.0/${maxima[name]}`})`).join("+")} DESC`
      }
      const rows = database
        .prepare(`${prefix}SELECT * FROM eligible ORDER BY ${order},provider,account,coalesce(chat,''),id LIMIT ?`)
        .all(...params, execution.limit + 1)
      check()
      const items = rows.slice(0, execution.limit).map((row, index): RankedStoreRow => {
        const components = Object.fromEntries(componentNames.map((name) => [name, finite(row[name])]))
        const score = options.weights ? rankingScore(components, maxima, options.weights) : null
        return {
          ...(row.pk == null
            ? {}
            : { counterObservations: counterStates(context, Number(row.pk), context.now(), 86_400_000) }),
          provider: String(row.provider),
          account: String(row.account),
          chatId: row.chat == null ? null : String(row.chat),
          id: String(row.id),
          name: row.name == null ? null : String(row.name),
          pk: row.pk == null ? null : Number(row.pk),
          kind: row.kind == null ? null : String(row.kind),
          rank: index + 1,
          value: score?.score ?? Number(row[options.measure]),
          components,
          messages: Number(row.messages),
          knownReactions: Number(row.known_reactions),
          unknownReactions: Number(row.unknown_reactions),
          score,
          ...(graph ? { graphComplete: Number(row.graph_complete) === 1 } : {}),
        }
      })
      const excludedUnknownSender =
        options.target === "contacts"
          ? Number(
              database.prepare(`SELECT count(*) AS n ${filtered} AND m.sender_identity_id IS NULL`).get(...params)?.n ??
                0,
            )
          : 0
      const excludedUnknownKind =
        options.messageKind !== "all"
          ? Number(
              database
                .prepare(
                  `SELECT count(*) AS n FROM ranking_selected s JOIN messages m ON m.id=s.id JOIN chats c ON c.id=m.chat_id LEFT JOIN ranking_derived d ON d.id=m.id LEFT JOIN ranking_quality q ON q.account_id=m.account_id WHERE (${kind}) IS NULL`,
                )
                .get()?.n ?? 0,
            )
          : 0
      const found: RankedStoreFound = {
        total,
        population,
        eligible,
        excludedMinimum,
        excludedMissing: population - excludedMinimum - eligible,
        excludedUnknownSender,
        excludedUnknownKind,
        items,
        maxima,
        hasMore: rows.length > execution.limit,
        ...(graph ? { graphQuality: graph } : {}),
      }
      inspect?.({ prefix, params, filtered, found, check })
      return found
    } finally {
      database.exec(
        "DROP TABLE ranking_graph; DROP TABLE ranking_quality; DROP TABLE ranking_derived; DROP TABLE ranking_selected",
      )
    }
  })
}
