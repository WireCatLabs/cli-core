import { CliError } from "@wirecat/cli-base"
import {
  type Engagement,
  inverseOf,
  notOverriddenSql,
  RELATION_KINDS,
  type RelationKind,
  rolesOf,
  STANDINGS,
  type Standing,
} from "../../domain/relations.js"
import type { AccountKey } from "../types.js"
import { linkKind } from "./link-kinds.js"
import { idsOf } from "./merged-persons.js"
import { linkOf } from "./notes.js"
import type { StoreContext } from "./open.js"
import { proposalOperationsOver } from "./proposed-actions.js"
import { type KnowledgeRelation, relationOf } from "./relation-proposals.js"
import { thingOf } from "./things.js"

export interface RelationFilter {
  kind?: RelationKind
  role?: string
  /** `proposed` holds the pending `relationship` proposals and the unconfirmed suggestions. */
  standing?: Standing
  from?: string
  to?: string
  /** Either end; each row then says its `direction` and, read backwards, the kind's inverse label. */
  about?: string
  /** Held at this time (UTC ms): started by then, or with no start, and not ended by then. */
  at?: number
  /** Ended relationships are left out unless asked for, or unless `standing` is `ended`. */
  includeEnded?: boolean
  /** A source's relationships only from these accounts; the owner's and agents' always. */
  accounts?: AccountKey[]
  /** No row with an end of these types, such as `deal` and `lead` a profile denies. */
  deniedKinds?: string[]
  limit?: number
  /** 1-based. */
  page?: number
}

export interface RelationListItem extends KnowledgeRelation {
  /** `proposal`: a pending `relationship` proposal, decided through the review list by its `id`. */
  source: "link" | "proposal"
  /** With `about`: whether that ref is the relationship's `from` (`outgoing`) or its `to` (`incoming`). */
  direction?: "outgoing" | "incoming"
  /** With `about` and `incoming`: how it reads backwards (`manages` for `reports-to`); `null` when it has none. */
  inverse?: string | null
  /** A stored role off the list its ends take, such as one written before the lists. */
  custom: boolean
}

export interface RelationList {
  /** Relationships and pending relationship proposals, filtered and paged in one query (WC-CMD-20). */
  listRelations(filter?: RelationFilter): Promise<{ items: RelationListItem[]; hasMore: boolean }>
}

type Row = Record<string, unknown>

const KINDS = RELATION_KINDS.map(linkKind).join(", ")
const typeOfRef = (column: string) => `substr(${column}, 1, instr(${column}, ':') - 1)`
const idOfRef = (column: string) => `CAST(substr(${column}, instr(${column}, ':') + 1) AS INTEGER)`

export const relationListOver = (context: StoreContext): RelationList => {
  const { database, now } = context
  const operations = proposalOperationsOver(context)
  const thing = (ref: string, what: string) => {
    const found = thingOf(database, ref)
    if (!found) throw new CliError("not_found", `${what} ${ref} is not in the local store`)
    return found
  }
  return {
    listRelations: async (filter = {}) => {
      const limit = filter.limit ?? 50
      const page = filter.page ?? 1
      if (!Number.isInteger(limit) || limit < 1 || limit > 500 || !Number.isInteger(page) || page < 1)
        throw new CliError("validation_error", "limit takes 1–500 and page starts at 1")
      if (filter.standing !== undefined && !STANDINGS.includes(filter.standing))
        throw new CliError("validation_error", `standing is one of ${STANDINGS.join(", ")}`)
      const at = now()
      const where: string[] = []
      const params: (string | number | null)[] = []
      const add = (sql: string, ...values: (string | number | null)[]) => {
        where.push(sql)
        params.push(...values)
      }
      const end = (side: "from" | "to", ref: string) => {
        const found = thing(ref, `the ${side} end`)
        add(
          `r.${side}_type = ? AND r.${side}_id IN (SELECT value FROM json_each(?))`,
          found.type,
          idsOf(database, found.type, found.id),
        )
      }
      if (filter.kind !== undefined) add("r.kind = ?", filter.kind)
      if (filter.role !== undefined) add("ifnull(r.role, '') = ?", filter.role.trim())
      if (filter.from !== undefined) end("from", filter.from)
      if (filter.to !== undefined) end("to", filter.to)
      const about = filter.about === undefined ? undefined : thing(filter.about, "the reference")
      if (about)
        add(
          `((r.from_type = ? AND r.from_id IN (SELECT value FROM json_each(?))) OR (r.to_type = ? AND r.to_id IN (SELECT value FROM json_each(?))))`,
          about.type,
          idsOf(database, about.type, about.id),
          about.type,
          idsOf(database, about.type, about.id),
        )
      if (filter.at !== undefined)
        add("(r.starts_at IS NULL OR r.starts_at <= ?) AND (r.ends_at IS NULL OR ? < r.ends_at)", filter.at, filter.at)
      if (filter.standing !== undefined) add("r.standing = ?", filter.standing)
      else if (!filter.includeEnded) add("r.standing <> 'ended'")
      if (filter.accounts !== undefined) {
        const ids = filter.accounts.flatMap((key) => {
          const row = database
            .prepare("SELECT id FROM accounts WHERE provider = ? AND external_id = ?")
            .get(key.provider, key.account)
          return row ? [Number(row.id)] : []
        })
        add(`(r.account_id IS NULL OR r.account_id IN (${ids.map(() => "?").join(", ") || "NULL"}))`, ...ids)
      }
      if (filter.deniedKinds?.length) {
        const list = filter.deniedKinds.map(() => "?").join(", ")
        add(`r.from_type NOT IN (${list}) AND r.to_type NOT IN (${list})`, ...filter.deniedKinds, ...filter.deniedKinds)
      }
      const rows = database
        .prepare(
          `SELECT r.source, r.id FROM (
            SELECT 'link' AS source, id, from_type, from_id, to_type, to_id, kind, role, account_id, starts_at, ends_at,
              created_at,
              CASE WHEN ends_at IS NOT NULL AND ends_at <= ? THEN 'ended' WHEN confirmed = 1 THEN 'confirmed'
                WHEN deleted_at IS NOT NULL THEN 'ended' WHEN account_id IS NOT NULL THEN 'reported'
                ELSE 'proposed' END AS standing
            FROM links WHERE kind IN (${KINDS}) AND to_id IS NOT NULL AND ${notOverriddenSql("links")}
            UNION ALL
            SELECT 'proposal', id, target_type, target_id, ${typeOfRef("json_extract(payload, '$.to')")},
              ${idOfRef("json_extract(payload, '$.to')")}, json_extract(payload, '$.kind'),
              json_extract(payload, '$.role'), NULL, json_extract(payload, '$.startsAt'),
              json_extract(payload, '$.endsAt'), created_at, 'proposed'
            FROM proposed_actions WHERE kind = 'relationship' AND status = 'proposed'
          ) r${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
          ORDER BY r.standing = 'ended', r.created_at, r.source, r.id LIMIT ? OFFSET ?`,
        )
        .all(at, ...params, limit + 1, (page - 1) * limit)
      const items = rows.slice(0, limit).map((row): RelationListItem => {
        const item = row.source === "link" ? linkItem(Number(row.id), at) : proposalItem(String(row.id))
        if (!about) return item
        const from = thingOf(database, item.from)
        const outgoing = from?.type === about.type && from.id === about.id
        return outgoing
          ? { ...item, direction: "outgoing" }
          : { ...item, direction: "incoming", inverse: inverseOf(item.kind) }
      })
      return { items, hasMore: rows.length > limit }
    },
  }

  function custom(kind: string, from: string, to: string, role: string | null): boolean {
    const fromThing = thingOf(database, from)
    const toThing = thingOf(database, to)
    const roles = fromThing && toThing ? rolesOf(kind, fromThing.type, toThing.type) : undefined
    return role !== null && roles !== undefined && !roles.includes(role)
  }

  function linkItem(id: number, at: number): RelationListItem {
    const relation = relationOf(
      linkOf(database, database.prepare("SELECT * FROM links WHERE id = ?").get(id) as Row),
      at,
    )
    return { ...relation, source: "link", custom: custom(relation.kind, relation.from, relation.to, relation.role) }
  }

  function proposalItem(id: string): RelationListItem {
    const action = operations.get(id)
    const payload = action.payload as {
      from: string
      to: string
      kind: RelationKind
      role?: string
      purpose?: string
      position?: string
      roleNote?: string
      engagement?: Engagement
      startsAt?: number
      endsAt?: number
    }
    const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString())
    return {
      id: action.id,
      from: payload.from,
      to: payload.to,
      kind: payload.kind,
      role: payload.role ?? null,
      purpose: payload.purpose ?? null,
      evidence: action.reason,
      confirmed: false,
      provenance: null,
      confidenceCategory: "weak",
      standing: "proposed",
      position: payload.position ?? null,
      roleNote: payload.roleNote ?? null,
      engagement: payload.engagement ?? null,
      startsAt: iso(payload.startsAt),
      endsAt: iso(payload.endsAt),
      createdAt: action.createdAt,
      source: "proposal",
      custom: custom(payload.kind, payload.from, payload.to, payload.role ?? null),
    }
  }
}
