import { CliError } from "@wirecat/cli-base"
import { assertMayDecide, type Decider, deciderAuthor } from "../decisions.js"
import { actorOfOrigin, botNamed, ownerPerson } from "./actors.js"
import type { RELATION_KINDS } from "./link-kinds.js"
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
  kind: (typeof RELATION_KINDS)[number]
  role: string | null
  /** What a chat is for in the project, from the purposes memo's config lists; `null` means `work`. */
  purpose: string | null
  evidence: string | null
  confirmed: boolean
  provenance: string | null
  confidenceCategory: "owner-confirmed" | "weak"
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

export const relationOf = (link: Link): KnowledgeRelation => ({
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
  return {
    /** The same pending pair returns the proposal already held. */
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
      },
      by: Exclude<Author, "owner">,
    ): ProposedAction => {
      const evidence = input.evidence ?? []
      if (!Array.isArray(evidence) || evidence.length > 5 || evidence.some((ref) => typeof ref !== "string"))
        throw new CliError("validation_error", "a relationship proposal cites up to 5 references")
      return write(database, () => {
        const held = database
          .prepare(
            "SELECT id FROM proposed_actions WHERE kind='relationship' AND status='proposed' AND target_type=? AND target_id=? " +
              "AND json_extract(payload,'$.to')=? AND json_extract(payload,'$.kind')=? ORDER BY id LIMIT 1",
          )
          .get(from.type, from.id, input.to, input.kind)
        if (held) return operations.get(String(held.id))
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
