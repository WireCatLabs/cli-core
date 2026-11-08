import { CliError } from "@wirecat/cli-base"
import { checkEnds, isSymmetric, type RelationKind } from "../../domain/relations.js"
import type { AccountKey } from "../types.js"
import { accountPk } from "./accounts.js"
import { crmLinkMode } from "./crm-settings.js"
import { linkKind } from "./link-kinds.js"
import type { Author } from "./memories.js"
import type { StoreContext } from "./open.js"
import { relationProposalsOver } from "./relation-proposals.js"
import { checkStoredRole } from "./relation-roles.js"
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
 * Which of the account's relationships a call reports completely: those from the `from` refs or to the `to` refs, of
 * these kinds and, when given, these roles. One it holds there and the call lacks is withdrawn; nothing else is touched.
 */
export interface ReportedScope {
  from: string[]
  to?: string[]
  kinds: RelationKind[]
  roles?: string[]
}

export interface ReportedIssue {
  reason: "relationship.reference-unknown" | "relationship.invalid"
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
  /** Left out: the owner removed or rejected that very relationship, role included. */
  skippedOwnerRejected: number
  issues: ReportedIssue[]
}

/** What a call did to one relationship. */
export interface ReportedOutcome {
  outcome: "added" | "kept" | "restored" | "withdrawn" | "proposed" | "skipped"
  /** `kind|from|to|role`, by the stored ends (a partnership's lower id first): one per relationship. */
  key: string
  /** The link that answers for it, the owner's when the owner holds it; `null` when proposed or skipped. */
  id: string | null
}

export interface ReportedOptions {
  /** `links.source` of a link it writes; `import` when absent. */
  source?: string
  /** Who proposes in `review` mode; the source's provider, as a rule, when absent. */
  by?: Exclude<Author, "owner">
  /** Called once per relationship, so a caller that reports in parts counts each one once per run. */
  onOutcome?: (outcome: ReportedOutcome) => void
}

const keyOf = (kind: unknown, fromType: unknown, fromId: unknown, toType: unknown, toId: unknown, role: unknown) =>
  `${String(kind)}|${String(fromType)}:${String(fromId)}|${String(toType)}:${String(toId)}|${role == null ? "" : String(role)}`

export interface RelationsStore {
  /**
   * Writes what a source account reports as a diff keyed by the relationship's unique key. A new one is a `reported`
   * link (a `relationship` proposal when the account's `crm.<provider>:<account>.links` is `review`); one held is
   * kept; one inside `scope` it no longer reports is withdrawn (`deleted_at`), never deleted. A link the owner
   * confirmed is never withdrawn, and one the owner removed or rejected, with the same role, is never written again.
   * Another role on a pair is another relationship. A ref the store does not hold is an issue, not an error.
   */
  syncReported(
    key: AccountKey,
    relationships: ReportedRelation[],
    scope: ReportedScope,
    options?: ReportedOptions,
  ): Promise<ReportedSync>
}

type Row = Record<string, unknown>

// links_relationship_key's WHERE, word for word: without it SQLite cannot use that partial index, picks
// (to_type, to_id) and reads every link of a busy end, such as a deal owner's, for each relationship (#2623).
export const KEYED =
  "kind IN ('member-of', 'related-to', 'reports-to', 'customer-of', 'partner-of') AND to_id IS NOT NULL"

const metadataOf = (relation: ReportedRelation) =>
  relation.metadata && Object.keys(relation.metadata).length ? JSON.stringify(relation.metadata) : null

/** The call, inside a transaction the caller holds: a CRM page saves its rows and their relationships together. */
export const syncReportedIn = (
  context: StoreContext,
  key: AccountKey,
  relationships: ReportedRelation[],
  scope: ReportedScope,
  { source = "import", by = { bot: key.provider, kind: "rule" }, onOutcome }: ReportedOptions = {},
): ReportedSync => {
  const { database, now } = context
  const proposals = relationProposalsOver(context)
  const accountId = accountPk(context, key)
  const review = crmLinkMode(database, key) === "review"
  const at = now()
  const result: ReportedSync = {
    added: 0,
    kept: 0,
    restored: 0,
    withdrawn: 0,
    proposed: 0,
    skippedOwnerRejected: 0,
    issues: [],
  }
  const seen = new Set<number>()
  const issue = (relation: ReportedRelation, reason: ReportedIssue["reason"], message: string) =>
    result.issues.push({ reason, message, from: relation.from, to: relation.to, kind: relation.kind })
  const samePair = `${KEYED} AND kind = ? AND from_type = ? AND from_id = ? AND to_type = ? AND to_id = ? AND anchor IS NULL`
  const sameKey = `${samePair} AND ifnull(role, '') = ?`

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
      if (role !== null) checkStoredRole(database, relation.kind, from.type, to.type, role)
    } catch (error) {
      if (!(error instanceof CliError)) throw error
      issue(relation, "relationship.invalid", error.message)
      continue
    }
    if (isSymmetric(relation.kind) && to.id < from.id) [from, to] = [to, from]
    const wanted = [relation.kind, from.type, from.id, to.type, to.id, role ?? ""] as const
    const linkKey = keyOf(relation.kind, from.type, from.id, to.type, to.id, role)
    const counted = (outcome: ReportedOutcome["outcome"], id: unknown) => {
      result[outcome === "skipped" ? "skippedOwnerRejected" : outcome] += 1
      onOutcome?.({ outcome, key: linkKey, id: id == null ? null : String(id) })
    }
    // The owner's link of the same role answers for the source too, and a confirmed one is never withdrawn.
    const owned: Row[] = database
      .prepare(`SELECT id, role, metadata FROM links WHERE ${samePair} AND confirmed = 1`)
      .all(...wanted.slice(0, 5))
    const confirmed = owned.find((link) => (link.role ?? "") === (role ?? "")) ?? ownerTook(context, owned, role)
    if (confirmed) {
      // The overridden link is the source's own: still reported, so it is not withdrawn.
      if (confirmed.reported != null) seen.add(Number(confirmed.reported))
      counted("kept", confirmed.id)
      continue
    }
    const toRef = referenceOfThing(database, to) as string
    if (rejected(context, from, toRef, relation.kind, role)) {
      counted("skipped", null)
      continue
    }
    const held = database.prepare(`SELECT * FROM links WHERE ${sameKey} AND account_id = ?`).get(...wanted, accountId)
    const startsAt = relation.startsAt ?? null
    const endsAt = relation.endsAt ?? null
    const metadata = metadataOf(relation)
    if (held) {
      seen.add(Number(held.id))
      counted(held.deleted_at != null ? "restored" : "kept", held.id)
      const same =
        held.deleted_at == null && held.starts_at === startsAt && held.ends_at === endsAt && held.metadata === metadata
      // Any write to a link queues its ends for involvement again, so an unchanged one is left alone.
      if (!same)
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
          from: referenceOfThing(database, from) as string,
          to: toRef,
          kind: relation.kind,
          ...(role === null ? {} : { role }),
          reason: `reported by ${key.provider}:${key.account}`,
        },
        by,
      )
      counted("proposed", null)
      continue
    }
    const row = database
      .prepare(
        "INSERT INTO links (from_type, from_id, to_type, to_id, kind, role, source, metadata, confirmed, account_id, " +
          "starts_at, ends_at, created_at, author, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?) " +
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
        by.kind ?? "agent",
        at,
      )
    seen.add(Number(row?.id))
    counted("added", row?.id)
  }

  const withdraw = database.prepare("UPDATE links SET deleted_at = ?, updated_at = ? WHERE id = ?")
  const kinds = scope.kinds.map(linkKind).join(", ")
  const roles = scope.roles?.map(() => "?").join(", ")
  const ends = [
    ...[...new Set(scope.from)].map((ref) => ["from", ref] as const),
    ...[...new Set(scope.to ?? [])].map((ref) => ["to", ref] as const),
  ]
  for (const [end, ref] of kinds ? ends : []) {
    const thing = thingOf(database, ref)
    if (!thing) continue
    // A partnership is stored once, either way round, so either end covers it.
    const match =
      end === "from"
        ? `((from_type = ? AND from_id = ?) OR (kind = ${linkKind("partner-of")} AND to_type = ? AND to_id = ?))`
        : `((to_type = ? AND to_id = ?) OR (kind = ${linkKind("partner-of")} AND from_type = ? AND from_id = ?))`
    // Only the writer's own links: a CRM sync and an import on one account never withdraw each other's.
    const rows: Row[] = database
      .prepare(
        `SELECT id, kind, from_type, from_id, to_type, to_id, role FROM links WHERE account_id = ? AND source = ? AND confirmed = 0 AND deleted_at IS NULL AND kind IN (${kinds}) ` +
          `AND ${match}${roles ? ` AND ifnull(role, '') IN (${roles})` : ""}`,
      )
      .all(accountId, source, thing.type, thing.id, thing.type, thing.id, ...(scope.roles ?? []))
    for (const row of rows)
      if (!seen.has(Number(row.id))) {
        seen.add(Number(row.id))
        withdraw.run(at, at, Number(row.id))
        result.withdrawn += 1
        const linkKey = keyOf(row.kind, row.from_type, row.from_id, row.to_type, row.to_id, row.role)
        onOutcome?.({ outcome: "withdrawn", key: linkKey, id: String(row.id) })
      }
  }
  return result
}

const parsed = (metadata: unknown): Record<string, unknown> => (metadata == null ? {} : JSON.parse(String(metadata)))

/**
 * The owner confirmed, or overrode, the pair's no-role link whose source called it `role`: once the role is listed, the
 * source reports it with that role, and it is the same relationship. `source_role` is one word or a list of them.
 * The answer names the overridden link as `reported`, if that is how the owner took it.
 */
const ownerTook = ({ database }: StoreContext, owned: Row[], role: string | null): Row | undefined => {
  if (role === null) return undefined
  const named = (link: Row | undefined) =>
    link?.role == null && [parsed(link?.metadata).source_role].flat().includes(role)
  const bare = owned.find((link) => link.role == null && named(link))
  if (bare) return bare
  for (const link of owned) {
    const overridden = parsed(link.metadata).overrides
    if (typeof overridden !== "number") continue
    const source = database.prepare("SELECT id, role, metadata FROM links WHERE id = ?").get(overridden)
    if (named(source)) return { ...link, reported: source?.id }
  }
  return undefined
}

/** The owner rejected or removed exactly this relationship: its pair, kind and role, whoever reported it. */
const rejected = ({ database }: StoreContext, from: Thing, to: string, kind: string, role: string | null): boolean =>
  database
    .prepare(
      "SELECT 1 FROM proposed_actions WHERE kind = 'relationship' AND status = 'rejected' AND target_type = ? " +
        "AND target_id = ? AND json_extract(payload, '$.to') = ? AND json_extract(payload, '$.kind') = ? " +
        "AND json_extract(payload, '$.role') IS ? LIMIT 1",
    )
    .get(from.type, from.id, to, kind, role) !== undefined

export const relationsStoreOver = (context: StoreContext): RelationsStore => ({
  syncReported: async (key, relationships, scope, options) =>
    write(context.database, () => syncReportedIn(context, key, relationships, scope, options)),
})
