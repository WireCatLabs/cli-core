import { CliError } from "@wirecat/cli-base"
import { checkEnds, checkRole, isSymmetric, type RelationKind } from "../../domain/relations.js"
import type { AccountKey } from "../types.js"
import { accountPk } from "./accounts.js"
import { crmLinkMode } from "./crm-settings.js"
import { linkKind } from "./link-kinds.js"
import { linkOf } from "./notes.js"
import type { StoreContext } from "./open.js"
import { relationProposalsOver } from "./relation-proposals.js"
import { referenceOfThing, type Thing, thingOf } from "./things.js"
import { write } from "./transaction.js"

/** One relationship as a source account reports it, by the store's refs. */
export interface ReportedRelation {
  from: string
  to: string
  kind: RelationKind
  role?: string | null
  /** Epoch ms; `endsAt` exclusive. Only what the source gives: never a guess. */
  startsAt?: number | null
  endsAt?: number | null
  /** Kept on the link: the source's own role name, a job title, how it was derived. */
  metadata?: Record<string, unknown>
}

/**
 * Which of the account's relationships a call reports completely: those from these refs, of these kinds and, when
 * given, these roles. One it holds there and the call lacks is withdrawn; nothing outside it is touched.
 */
export interface ReportedScope {
  from: string[]
  kinds: RelationKind[]
  roles?: string[]
}

export interface ReportedIssue {
  reason: "relationship.reference-unknown" | "relationship.invalid" | "relationship.owner-rejected"
  message: string
  from: string
  to: string
  kind: RelationKind
}

export interface ReportedSync {
  added: number
  kept: number
  restored: number
  withdrawn: number
  /** New relationships waiting as `relationship` proposals: the account's setting is `review`. */
  proposed: number
  /** Relationships that contradict the owner's: one `relationship_update` proposal each, the owner's link unchanged. */
  conflicts: number
  issues: ReportedIssue[]
}

export interface RelationsStore {
  /**
   * Writes what a source account reports as a diff keyed by the relationship's unique key: a new one is added as
   * `reported` (a proposal when the account's `crm.<account>.links` setting is `review`), one held is kept, one it no
   * longer reports is withdrawn (`deleted_at`), never deleted, unless the owner confirmed it. The owner's link always wins: a different role reported
   * on a pair the owner confirmed is a `relationship_update` proposal, and a pair the owner removed or rejected is
   * left out. A ref the store does not hold is an issue, not an error.
   */
  syncReported(
    key: AccountKey,
    relationships: ReportedRelation[],
    scope: ReportedScope,
    options?: { source?: string },
  ): Promise<ReportedSync>
}

type Row = Record<string, unknown>

const metadataOf = (relation: ReportedRelation) =>
  relation.metadata && Object.keys(relation.metadata).length ? JSON.stringify(relation.metadata) : null

/** The call, inside a transaction the caller holds: a CRM page saves its rows and their relationships together. */
export const syncReportedIn = (
  context: StoreContext,
  key: AccountKey,
  relationships: ReportedRelation[],
  scope: ReportedScope,
  { source = "import" }: { source?: string } = {},
): ReportedSync => {
  const { database, now } = context
  const proposals = relationProposalsOver(context)
  const by = { bot: key.provider, kind: "rule" as const }
  const accountId = accountPk(context, key)
  const review = crmLinkMode(database, key) === "review"
  const at = now()
  const result: ReportedSync = { added: 0, kept: 0, restored: 0, withdrawn: 0, proposed: 0, conflicts: 0, issues: [] }
  const seen = new Set<number>()
  const issue = (relation: ReportedRelation, reason: ReportedIssue["reason"], message: string) =>
    result.issues.push({ reason, message, from: relation.from, to: relation.to, kind: relation.kind })
  const pairOf = "kind = ? AND from_type = ? AND from_id = ? AND to_type = ? AND to_id = ? AND anchor IS NULL"

  for (const relation of relationships) {
    let from = thingOf(database, relation.from)
    let to = thingOf(database, relation.to)
    if (!from || !to) {
      issue(relation, "relationship.reference-unknown", `${!from ? relation.from : relation.to} is not in the store`)
      continue
    }
    const role = relation.role?.trim() || null
    try {
      if (from.type === to.type && from.id === to.id)
        throw new CliError("validation_error", "a relationship needs two distinct ends")
      checkEnds(relation.kind, from.type, to.type)
      if (role !== null) checkRole(relation.kind, from.type, to.type, role)
    } catch (error) {
      if (!(error instanceof CliError)) throw error
      issue(relation, "relationship.invalid", error.message)
      continue
    }
    if (isSymmetric(relation.kind) && to.id < from.id) [from, to] = [to, from]
    const ends = [relation.kind, from.type, from.id, to.type, to.id] as const
    const owners = database
      .prepare(`SELECT * FROM links WHERE ${pairOf} AND confirmed = 1 AND deleted_at IS NULL ORDER BY id`)
      .all(...ends)
    if (owners.some((row) => (row.role ?? null) === role)) continue
    const fromRef = referenceOfThing(database, from) as string
    const toRef = referenceOfThing(database, to) as string
    const other = owners.find((row) => row.role != null)
    if (other && role !== null) {
      proposals.proposeUpdate(
        linkOf(database, other),
        { role, reason: `${key.provider}:${key.account} reports the role ${role}` },
        by,
      )
      result.conflicts += 1
      continue
    }
    if (owners.length === 0 && rejectedPair(context, from, toRef, relation.kind)) {
      issue(relation, "relationship.owner-rejected", "the owner removed or rejected this relationship; it stays out")
      continue
    }
    const held = database
      .prepare(`SELECT * FROM links WHERE ${pairOf} AND ifnull(role, '') = ? AND account_id = ?`)
      .get(...ends, role ?? "", accountId)
    const startsAt = relation.startsAt ?? null
    const endsAt = relation.endsAt ?? null
    const metadata = metadataOf(relation)
    if (held) {
      seen.add(Number(held.id))
      if (held.deleted_at != null) result.restored += 1
      else result.kept += 1
      database
        .prepare(
          "UPDATE links SET deleted_at = NULL, starts_at = ?, ends_at = ?, metadata = ?, updated_at = ? WHERE id = ?",
        )
        .run(startsAt, endsAt, metadata, at, Number(held.id))
      continue
    }
    if (review) {
      proposals.propose(
        from,
        {
          from: fromRef,
          to: toRef,
          kind: relation.kind,
          ...(role === null ? {} : { role }),
          reason: `reported by ${key.provider}:${key.account}`,
        },
        by,
      )
      result.proposed += 1
      continue
    }
    const row = database
      .prepare(
        "INSERT INTO links (from_type, from_id, to_type, to_id, kind, role, source, metadata, confirmed, account_id, " +
          "starts_at, ends_at, created_at, author, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'rule', ?) " +
          "RETURNING id",
      )
      .get(
        from.type,
        from.id,
        to.type,
        to.id,
        relation.kind,
        role,
        source,
        metadata,
        accountId,
        startsAt,
        endsAt,
        at,
        at,
      )
    seen.add(Number(row?.id))
    result.added += 1
  }

  const withdraw = database.prepare("UPDATE links SET deleted_at = ?, updated_at = ? WHERE id = ?")
  const kinds = scope.kinds.map(linkKind).join(", ")
  const roles = scope.roles?.map(() => "?").join(", ")
  for (const ref of new Set(scope.from)) {
    const thing = thingOf(database, ref)
    if (!thing || !kinds) continue
    const rows: Row[] = database
      .prepare(
        `SELECT id FROM links WHERE account_id = ? AND confirmed = 0 AND deleted_at IS NULL AND kind IN (${kinds}) AND ` +
          `((from_type = ? AND from_id = ?) OR (kind = ${linkKind("partner-of")} AND to_type = ? AND to_id = ?))` +
          (roles ? ` AND ifnull(role, '') IN (${roles})` : ""),
      )
      .all(accountId, thing.type, thing.id, thing.type, thing.id, ...(scope.roles ?? []))
    for (const row of rows)
      if (!seen.has(Number(row.id))) {
        withdraw.run(at, at, Number(row.id))
        result.withdrawn += 1
      }
  }
  return result
}

/** A `relationship` proposal for the pair the owner rejected, or the rejection a removed link left behind. */
const rejectedPair = ({ database }: StoreContext, from: Thing, to: string, kind: string): boolean =>
  database
    .prepare(
      "SELECT 1 FROM proposed_actions WHERE kind = 'relationship' AND status = 'rejected' AND target_type = ? " +
        "AND target_id = ? AND json_extract(payload, '$.to') = ? AND json_extract(payload, '$.kind') = ? LIMIT 1",
    )
    .get(from.type, from.id, to, kind) !== undefined

export const relationsStoreOver = (context: StoreContext): RelationsStore => ({
  syncReported: async (key, relationships, scope, options) =>
    write(context.database, () => syncReportedIn(context, key, relationships, scope, options)),
})
