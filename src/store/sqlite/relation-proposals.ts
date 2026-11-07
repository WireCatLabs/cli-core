import { CliError } from "@wirecat/cli-base"
import { type RelationKind, type Standing, standingOf } from "../../domain/relations.js"
import { assertMayDecide, botKey, type Decider, deciderAuthor } from "../decisions.js"
import { actorOfOrigin, botNamed, ownerPerson } from "./actors.js"
import type { Author } from "./memories.js"
import { insertLink, type Link, linkOf, purposeOf } from "./notes.js"
import type { StoreContext } from "./open.js"
import { type ProposedAction, proposalOperationsOver, proposerOfAction } from "./proposed-actions.js"
import { type Thing, thingOf } from "./things.js"
import { write } from "./transaction.js"

type Row = Record<string, unknown>

export interface KnowledgeRelation {
  id: string
  from: string
  to: string
  kind: RelationKind
  role: string | null
  /** What a chat is for in the project, from the purposes memo's config lists; `null` means `work`. */
  purpose: string | null
  evidence: string | null
  confirmed: boolean
  provenance: string | null
  confidenceCategory: "owner-confirmed" | "weak"
  /** Derived from the link: the owner's, a source's nobody confirmed, a suggestion, or one that ended. */
  standing: Standing
  createdAt: string
}

export interface RelateInput {
  from: string
  to: string
  kind: KnowledgeRelation["kind"]
  role?: string
  purpose?: string
  evidence?: string
  confirmed?: boolean
  provenance?: string
}

export const relationOf = (link: Link, now: number): KnowledgeRelation => ({
  id: link.id,
  from: link.from,
  to: String(link.to),
  kind: link.kind as KnowledgeRelation["kind"],
  role: link.role,
  purpose: link.purpose,
  evidence: link.evidence,
  confirmed: link.confirmed,
  provenance: link.provenance,
  confidenceCategory: link.confirmed ? "owner-confirmed" : "weak",
  standing: standingOf(link, now),
  createdAt: link.createdAt,
})

/** `relationship` proposals in `proposed_actions`: an agent's or a rule's, and the rejected ones a scan skips. */
export const relationProposalsOver = (context: StoreContext) => {
  const { database, now } = context
  const operations = proposalOperationsOver(context)
  /** The rejected `relationship` proposal a removed link leaves behind, so a scan never proposes it again. */
  const rejected = (link: Link, by: Decider, reason?: string): void => {
    const at = now()
    const proposed = link.confirmed ? ownerPerson(database) : actorOfOrigin(database, "agent")
    const decided = by === "owner" ? ownerPerson(database) : botNamed(database, by.bot, at)
    const why = [
      `${link.confirmed ? "removed" : "rejected"} by ${by === "owner" ? "the owner" : `agent:${by.bot}`}`,
      by === "owner" ? undefined : by.reason.trim(),
      reason?.trim() || undefined,
    ].filter(Boolean)
    const from = thingOf(database, link.from)
    database
      .prepare(
        "INSERT INTO proposed_actions (kind, target_type, target_id, payload, reason, status, proposed_by_type, " +
          "proposed_by_id, decided_by_type, decided_by_id, decided_at, result, created_at, updated_at) " +
          "VALUES ('relationship', ?, ?, ?, ?, 'rejected', ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        from?.type ?? null,
        from?.id ?? null,
        JSON.stringify({ from: link.from, to: link.to, kind: link.kind, ...(link.role ? { role: link.role } : {}) }),
        link.evidence,
        proposed.type,
        proposed.id,
        decided.type,
        decided.id,
        at,
        JSON.stringify({ reason: why.join(": "), link: link.id }),
        at,
        at,
      )
  }
  const applyUpdate = (link: Link, input: RelationUpdate): Link => {
    const changes = changesOf(input)
    if ("role" in changes) {
      const taken = database
        .prepare(
          "SELECT b.id FROM links a JOIN links b ON b.kind = a.kind AND b.from_type = a.from_type AND b.from_id = a.from_id " +
            "AND b.to_type = a.to_type AND b.to_id = a.to_id AND b.anchor IS a.anchor AND b.account_id IS a.account_id " +
            "AND ifnull(b.role, '') = ifnull(?, '') AND b.id <> a.id WHERE a.id = ?",
        )
        .get(changes.role ?? null, Number(link.id))
      if (taken)
        throw new CliError("validation_error", `relationship ${String(taken.id)} already holds that role`, {
          reason: "relationship.exists",
        })
    }
    database
      .prepare(
        "UPDATE links SET role = CASE WHEN ? THEN ? ELSE role END, purpose = CASE WHEN ? THEN ? ELSE purpose END, " +
          "updated_at = ? WHERE id = ?",
      )
      .run(
        Number("role" in changes),
        changes.role ?? null,
        Number("purpose" in changes),
        changes.purpose ?? null,
        now(),
        Number(link.id),
      )
    return linkOf(database, database.prepare("SELECT * FROM links WHERE id = ?").get(Number(link.id)) as Row)
  }
  /**
   * A scan's newer score on a pending proposal, in place under the same id. A rule's own row takes the new score,
   * signals, evidence and purpose; another proposer's row keeps its author, evidence and purpose and gains the signals.
   */
  const rescored = (
    action: ProposedAction,
    input: { evidence?: string[]; purpose?: string; reason?: string },
    scored: Required<Scored>,
    by: Exclude<Author, "owner">,
  ): ProposedAction => {
    const proposer = proposerOfAction(action)
    const own = proposer.type === "bot" && proposer.kind === "rule" && botKey(proposer.name) === botKey(by.bot)
    const before = action.payload as Record<string, unknown>
    const payload = own
      ? {
          ...before,
          ...scored,
          evidence: input.evidence ?? [],
          ...(input.purpose === undefined ? {} : { purpose: purposeOf(input.purpose) }),
        }
      : { ...before, ...scored }
    const reason = own && input.reason !== undefined ? input.reason : action.reason
    if (JSON.stringify(payload) === JSON.stringify(before) && reason === action.reason) return action
    database
      .prepare(
        "UPDATE proposed_actions SET payload = ?, reason = ?, updated_at = ? WHERE id = ? AND status = 'proposed'",
      )
      .run(JSON.stringify(payload), reason, now(), Number(action.id))
    return operations.get(action.id)
  }
  return {
    /**
     * Where a pair stands before a scan proposes it: a link joins it, a `relationship` proposal for it was rejected,
     * or one is pending. A rejection is matched by the pair alone, whoever proposed it and with whatever scorer.
     */
    state: (
      paired: () => { from: Thing; existing: Row | undefined; ends: { to: string } },
      { kind }: { kind: string },
    ): { linked: boolean; confirmed: boolean; rejected: boolean; pending: ProposedAction | null } | undefined => {
      let found: ReturnType<typeof paired>
      try {
        found = paired()
      } catch (error) {
        if (error instanceof CliError && (error.code === "not_found" || error.code === "validation_error")) return
        throw error
      }
      const { from, existing } = found
      const { to } = found.ends
      const rows = database
        .prepare(
          "SELECT id, status FROM proposed_actions WHERE kind='relationship' AND status IN ('proposed','rejected') " +
            "AND target_type=? AND target_id=? AND json_extract(payload,'$.to')=? AND json_extract(payload,'$.kind')=? " +
            "ORDER BY id",
        )
        .all(from.type, from.id, to, kind)
      const pending = rows.find((row) => row.status === "proposed")
      return {
        linked: existing !== undefined,
        confirmed: existing !== undefined && Number(existing.confirmed) === 1,
        rejected: rows.some((row) => row.status === "rejected"),
        pending: pending ? operations.get(String(pending.id)) : null,
      }
    },

    /** The same pending pair returns the proposal already held; a scored one updates its score in place. */
    propose: (
      from: Thing,
      input: {
        from: string
        to: string
        kind: string
        role?: string
        purpose?: string
        evidence?: string[]
        reason?: string
      } & Scored,
      by: Exclude<Author, "owner">,
    ): ProposedAction => {
      const evidence = input.evidence ?? []
      if (!Array.isArray(evidence) || evidence.length > 5 || evidence.some((ref) => typeof ref !== "string"))
        throw new CliError("validation_error", "a relationship proposal cites up to 5 references")
      const scored = scoredOf(input)
      return write(database, () => {
        const held = database
          .prepare(
            "SELECT id FROM proposed_actions WHERE kind='relationship' AND status='proposed' AND target_type=? AND target_id=? " +
              "AND json_extract(payload,'$.to')=? AND json_extract(payload,'$.kind')=? " +
              "AND (? IS NULL OR json_extract(payload,'$.role') IS ?) ORDER BY id LIMIT 1",
          )
          .get(from.type, from.id, input.to, input.kind, input.role ?? null, input.role ?? null)
        if (held) {
          const action = operations.get(String(held.id))
          return scored ? rescored(action, input, scored, by) : action
        }
        return operations.propose({
          kind: "relationship",
          by,
          target: input.from,
          payload: {
            from: input.from,
            to: input.to,
            kind: input.kind,
            ...(input.role === undefined ? {} : { role: input.role }),
            ...(input.purpose === undefined ? {} : { purpose: purposeOf(input.purpose) }),
            evidence,
            ...scored,
          },
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        })
      })
    },

    rejected: (link: Link, by: Decider, reason?: string): void => rejected(link, by, reason),

    update: (link: Link, input: RelationUpdate): Link => write(database, () => applyUpdate(link, input)),

    proposeUpdate: (link: Link, input: RelationUpdate & { reason?: string }, by: Exclude<Author, "owner">) => {
      const changes = changesOf(input)
      return write(database, () => {
        const from = thingOf(database, link.from)
        const held = database
          .prepare(
            "SELECT id FROM proposed_actions WHERE kind='relationship_update' AND status='proposed' AND target_type=? " +
              "AND target_id=? AND json_extract(payload,'$.relationship')=? AND json_extract(payload,'$.changes')=json(?) " +
              "ORDER BY id LIMIT 1",
          )
          .get(from?.type ?? null, from?.id ?? null, link.id, JSON.stringify(changes))
        if (held) return operations.get(String(held.id))
        return operations.propose({
          kind: "relationship_update",
          by,
          target: link.from,
          payload: {
            relationship: link.id,
            from: link.from,
            to: link.to,
            kind: link.kind,
            changes,
            before: { role: link.role, purpose: link.purpose },
          },
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        })
      })
    },

    decideUpdate: (id: string, decision: LinkDecision): { proposal: ProposedAction; link: Link | null } =>
      write(database, () => {
        const proposal = operations.get(id)
        if (proposal.kind !== "relationship_update")
          throw new CliError("validation_error", `${id} is a ${proposal.kind} proposal, not a relationship change`)
        assertMayDecide({ id, proposedBy: proposerOfAction(proposal) }, decision.by, context.decisions)
        const author = deciderAuthor(decision.by)
        const reason = decision.reason?.trim() || undefined
        if (!decision.confirm)
          return { proposal: operations.reject(id, author, reason === undefined ? undefined : { reason }), link: null }
        const payload = proposal.payload as { relationship: string; changes: RelationUpdate }
        const row = database.prepare("SELECT * FROM links WHERE id = ?").get(Number(payload.relationship))
        if (!row) throw new CliError("not_found", `relationship ${payload.relationship} is gone`)
        const link = applyUpdate(linkOf(database, row), payload.changes)
        return {
          proposal: operations.approve(
            id,
            { relationship: link.id, ...(reason === undefined ? {} : { reason }) },
            author,
          ),
          link,
        }
      }),

    /**
     * Decides a stored `relationship` or `key_document` proposal in one transaction: the confirmed link and the
     * decision land together or not at all.
     */
    decideProposal: (id: string, decision: LinkDecision): { proposal: ProposedAction; link: Link | null } =>
      write(database, () => {
        const proposal = operations.get(id)
        if (proposal.kind !== "relationship" && proposal.kind !== "key_document")
          throw new CliError("validation_error", `${id} is a ${proposal.kind} proposal, not a link`)
        assertMayDecide({ id, proposedBy: proposerOfAction(proposal) }, decision.by, context.decisions)
        const author = deciderAuthor(decision.by)
        const reason = decision.reason?.trim() || undefined
        if (!decision.confirm)
          return { proposal: operations.reject(id, author, reason === undefined ? undefined : { reason }), link: null }
        const payload = proposal.payload as {
          from?: string
          to?: string
          ref?: string
          project?: string
          kind?: string
          role?: string
          purpose?: string
        }
        const key = proposal.kind === "key_document"
        const link = insertLink(context, {
          from: String(key ? payload.ref : payload.from),
          to: String(key ? payload.project : payload.to),
          kind: key ? "related-to" : ((payload.kind ?? "member-of") as Link["kind"]),
          ...(key ? { role: "key" } : payload.role === undefined ? {} : { role: payload.role }),
          ...(key || payload.purpose === undefined ? {} : { purpose: payload.purpose }),
          ...(proposal.reason === null ? {} : { evidence: proposal.reason }),
          ...decidedOrigin(decision.by),
        })
        return {
          proposal: operations.approve(id, { link: link.id, ...(reason === undefined ? {} : { reason }) }, author),
          link,
        }
      }),

    /** Decides an unconfirmed link written before proposals were stored; only the owner may, as its author is unknown. */
    decideLink: (id: string, decision: LinkDecision): Link | null =>
      write(database, () => {
        const row = /^\d+$/.test(id)
          ? database.prepare("SELECT * FROM links WHERE id = ? AND confirmed = 0").get(Number(id))
          : undefined
        if (!row) throw new CliError("not_found", `no suggested link ${id}`)
        assertMayDecide({ id: `link:${id}`, proposedBy: { type: "unknown" } }, decision.by, context.decisions)
        const link = linkOf(database, row)
        if (!decision.confirm) {
          rejected(link, decision.by, decision.reason)
          database.prepare("UPDATE links SET updated_at = ? WHERE id = ?").run(now(), Number(id))
          database.prepare("DELETE FROM links WHERE id = ?").run(Number(id))
          return null
        }
        database
          .prepare("UPDATE links SET confirmed=1, source='owner', author='owner', updated_at=? WHERE id=?")
          .run(now(), Number(id))
        return linkOf(
          database,
          database.prepare("SELECT * FROM links WHERE id = ?").get(Number(id)) as Record<string, unknown>,
        )
      }),
  }
}

/** What a scan adds to a relationship proposal: the combined score and each scorer's part in it. */
export interface Scored {
  score?: number
  signals?: { scorer: string; weight: number; why: string }[]
}

const scoredOf = (input: Scored): Required<Scored> | undefined => {
  if (input.score === undefined && input.signals === undefined) return undefined
  const { score, signals } = input
  if (typeof score !== "number" || !(score >= 0 && score <= 1) || !Array.isArray(signals) || signals.length > 20)
    throw new CliError("validation_error", "a scored proposal takes a score of 0–1 and up to 20 signals")
  for (const signal of signals)
    if (
      typeof signal?.scorer !== "string" ||
      typeof signal.why !== "string" ||
      signal.why.length > 500 ||
      typeof signal.weight !== "number" ||
      !(signal.weight >= 0 && signal.weight <= 1)
    )
      throw new CliError("validation_error", "a signal names its scorer, a weight of 0–1 and why, up to 500 characters")
  return { score, signals: signals.map(({ scorer, weight, why }) => ({ scorer, weight, why })) }
}

/** A relationship's role and purpose to set; `null` clears one. */
export interface RelationUpdate {
  role?: string | null
  purpose?: string | null
}

/** What a relationship update sets, checked; `null` clears a field and an absent one is left alone. */
const changesOf = (input: RelationUpdate): RelationUpdate => {
  const changes: RelationUpdate = {}
  if (input.role !== undefined) changes.role = input.role === null ? null : roleOf(input.role)
  if (input.purpose !== undefined) changes.purpose = input.purpose === null ? null : purposeOf(input.purpose)
  if (!Object.keys(changes).length)
    throw new CliError("validation_error", "a relationship update sets a role, a purpose or both")
  return changes
}

const roleOf = (role: string): string => {
  const value = role.trim()
  if (!value || value.length > 200) throw new CliError("validation_error", "a role takes 1–200 characters")
  return value
}

export interface LinkDecision {
  confirm: boolean
  by: Decider
  reason?: string
}

/** A link an agent confirmed for the owner says so in its provenance. */
const decidedOrigin = (by: Decider) =>
  by === "owner"
    ? { origin: "owner" as const }
    : {
        origin: "suggested" as const,
        confirmed: true,
        provenance: `agent:${by.bot} for the owner: ${by.reason.trim()}`,
      }
