import { CliError } from "@wirecat/cli-base"
import {
  checkEngagement,
  type Engagement,
  type RelationKind,
  type Standing,
  standingOf,
} from "../../domain/relations.js"
import { assertMayDecide, botKey, type Decider, deciderAuthor } from "../decisions.js"
import { actorOfOrigin, botNamed, ownerPerson } from "./actors.js"
import type { Author } from "./memories.js"
import { insertLink, type Link, linkOf, purposeOf } from "./notes.js"
import type { StoreContext } from "./open.js"
import { type ProposedAction, proposalOperationsOver, proposerOfAction } from "./proposed-actions.js"
import { checkStoredRole } from "./relation-roles.js"
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
  /** A job title beside the relationship, never its role. */
  position: string | null
  /** What the role means here, in the owner's words. */
  roleNote: string | null
  /** How much the owner deals with a person on a project himself; `null` is unknown. */
  engagement: Engagement | null
  /** The source's own words for it, off the role list (`metadata.source_role`), never its role. */
  sourceRoles?: string[]
  /** When it held, as ISO times; `endsAt` exclusive; `null` when nobody said. */
  startsAt: string | null
  endsAt: string | null
  /** The source account that reported it, `<provider>:<account>`; absent for the owner's and an agent's. */
  account?: string
  /** How a source made it when it stated none, such as `department-head`. */
  derived?: string
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
  position?: string
  roleNote?: string
  engagement?: Engagement
  /** UTC ms; `endsAt` exclusive and after `startsAt`. */
  startsAt?: number
  endsAt?: number
}

const isoOf = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString())

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
  position: link.position ?? null,
  roleNote: link.roleNote ?? null,
  engagement: link.engagement ?? null,
  ...(link.sourceRoles ? { sourceRoles: link.sourceRoles } : {}),
  startsAt: isoOf(link.startsAt),
  endsAt: isoOf(link.endsAt),
  ...(link.account === undefined ? {} : { account: link.account }),
  ...(link.derived === undefined ? {} : { derived: link.derived }),
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
  /** The role lists may have changed since a proposal was made: a role is checked when it is written. */
  const checkedRole = (link: Link, { role, engagement }: RelationUpdate) => {
    const [fromType, , toType] = fromTo(link)
    if (typeof role === "string") checkStoredRole(database, link.kind, fromType, toType, role)
    if (typeof engagement === "string") checkEngagement(link.kind, fromType, toType, engagement)
  }
  /** The link's metadata with the changed fields set or, when `null`, removed; `undefined` when none changed. */
  const metadataOf = (link: Link, changes: RelationUpdate): string | undefined => {
    const fields = METADATA_FIELDS.filter((field) => field in changes)
    if (!fields.length) return
    const row = database.prepare("SELECT metadata FROM links WHERE id = ?").get(Number(link.id))
    const metadata = row?.metadata == null ? {} : (JSON.parse(String(row.metadata)) as Record<string, unknown>)
    for (const field of fields)
      if (changes[field] == null) delete metadata[field]
      else metadata[field] = changes[field]
    return JSON.stringify(metadata)
  }
  const applyUpdate = (link: Link, input: RelationUpdate): Link => {
    const changes = changesOf(input)
    checkedRole(link, changes)
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
    const startsAt = "startsAt" in changes ? (changes.startsAt ?? undefined) : link.startsAt
    const endsAt = "endsAt" in changes ? (changes.endsAt ?? undefined) : link.endsAt
    spanOf(startsAt, endsAt)
    const metadata = metadataOf(link, changes)
    database
      .prepare(
        "UPDATE links SET role = CASE WHEN ? THEN ? ELSE role END, purpose = CASE WHEN ? THEN ? ELSE purpose END, " +
          "starts_at = CASE WHEN ? THEN ? ELSE starts_at END, ends_at = CASE WHEN ? THEN ? ELSE ends_at END, " +
          "metadata = CASE WHEN ? THEN ? ELSE metadata END, updated_at = ? WHERE id = ?",
      )
      .run(
        Number("role" in changes),
        changes.role ?? null,
        Number("purpose" in changes),
        changes.purpose ?? null,
        Number("startsAt" in changes),
        changes.startsAt ?? null,
        Number("endsAt" in changes),
        changes.endsAt ?? null,
        Number(metadata !== undefined),
        metadata ?? null,
        now(),
        Number(link.id),
      )
    return linkOf(database, database.prepare("SELECT * FROM links WHERE id = ?").get(Number(link.id)) as Row)
  }
  /**
   * The owner's change. On a link a source reported, the source's row stays for its sync to diff, and one owner link
   * overrides it (`metadata.overrides`): made by the first change, changed in place by every later one. Reads show the
   * override instead of the source's row.
   */
  const ownerUpdate = (link: Link, input: RelationUpdate): Link => {
    if (link.accountId === undefined || link.confirmed) return applyUpdate(link, input)
    const held = database
      .prepare(
        "SELECT * FROM links WHERE kind = ? AND from_type = ? AND from_id = ? AND to_type = ? AND to_id = ? " +
          "AND account_id IS NULL AND json_extract(metadata, '$.overrides') = ?",
      )
      .get(...endsOf(link), Number(link.id))
    if (held) return applyUpdate(linkOf(database, held), input)
    const changes = changesOf(input)
    const pick = <K extends keyof RelationUpdate>(key: K, kept: RelationUpdate[K]) =>
      key in changes ? changes[key] : kept
    const role = pick("role", link.role) ?? null
    const at = now()
    const metadata = JSON.stringify({
      overrides: Number(link.id),
      ...(link.position ? { position: link.position } : {}),
      ...(link.roleNote ? { roleNote: link.roleNote } : {}),
      ...(link.engagement ? { engagement: link.engagement } : {}),
    })
    // An owner link of that role on the pair already (from `relate`) becomes the override rather than a second one.
    const same = database
      .prepare(
        "SELECT id FROM links WHERE kind = ? AND from_type = ? AND from_id = ? AND to_type = ? AND to_id = ? " +
          "AND account_id IS NULL AND anchor IS NULL AND ifnull(role, '') = ?",
      )
      .get(...endsOf(link), role ?? "")
    const id = same
      ? Number(same.id)
      : Number(
          database
            .prepare(
              "INSERT INTO links (from_type, from_id, to_type, to_id, kind, role, purpose, source, metadata, confirmed, " +
                "starts_at, ends_at, created_at, author, updated_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, 'owner', ?, 1, ?, ?, ?, 'owner', ?) RETURNING id",
            )
            .get(
              ...fromTo(link),
              link.kind,
              role,
              link.purpose,
              metadata,
              link.startsAt ?? null,
              link.endsAt ?? null,
              at,
              at,
            )?.id,
        )
    if (same)
      database
        .prepare("UPDATE links SET metadata = json_set(coalesce(metadata, '{}'), '$.overrides', ?) WHERE id = ?")
        .run(Number(link.id), id)
    const { role: _, ...rest } = changes
    const owned = linkOf(database, database.prepare("SELECT * FROM links WHERE id = ?").get(id) as Row)
    return Object.keys(rest).length ? applyUpdate(owned, rest) : owned
  }
  const fromTo = (link: Link) => {
    const from = thingOf(database, link.from) as Thing
    const to = thingOf(database, String(link.to)) as Thing
    return [from.type, from.id, to.type, to.id] as const
  }
  const endsOf = (link: Link) => {
    const [fromType, fromId, toType, toId] = fromTo(link)
    return [link.kind, fromType, fromId, toType, toId] as const
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
        position?: string
        roleNote?: string
        engagement?: Engagement
        startsAt?: number
        endsAt?: number
        evidence?: string[]
        reason?: string
      } & Scored,
      by: Exclude<Author, "owner">,
    ): ProposedAction => {
      spanOf(input.startsAt, input.endsAt)
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
            ...(input.position === undefined ? {} : { position: positionOf(input.position) }),
            ...(input.roleNote === undefined ? {} : { roleNote: roleNoteOf(input.roleNote) }),
            ...(input.engagement === undefined ? {} : { engagement: input.engagement }),
            ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }),
            ...(input.endsAt === undefined ? {} : { endsAt: input.endsAt }),
            evidence,
            ...scored,
          },
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        })
      })
    },

    rejected: (link: Link, by: Decider, reason?: string): void => rejected(link, by, reason),

    update: (link: Link, input: RelationUpdate): Link => write(database, () => ownerUpdate(link, input)),

    proposeUpdate: (link: Link, input: RelationUpdate & { reason?: string }, by: Exclude<Author, "owner">) => {
      const changes = changesOf(input)
      checkedRole(link, changes)
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
            before: {
              role: link.role,
              purpose: link.purpose,
              position: link.position ?? null,
              roleNote: link.roleNote ?? null,
              engagement: link.engagement ?? null,
              startsAt: link.startsAt ?? null,
              endsAt: link.endsAt ?? null,
            },
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
        const link = ownerUpdate(linkOf(database, row), payload.changes)
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
          position?: string
          roleNote?: string
          engagement?: Engagement
          startsAt?: number
          endsAt?: number
        }
        const key = proposal.kind === "key_document"
        const ends = key ? undefined : [thingOf(database, String(payload.from)), thingOf(database, String(payload.to))]
        if (ends?.[0] && ends[1] && payload.role !== undefined)
          checkStoredRole(database, payload.kind ?? "member-of", ends[0].type, ends[1].type, payload.role)
        if (ends?.[0] && ends[1] && payload.engagement !== undefined)
          checkEngagement(payload.kind ?? "member-of", ends[0].type, ends[1].type, payload.engagement)
        const link = insertLink(context, {
          from: String(key ? payload.ref : payload.from),
          to: String(key ? payload.project : payload.to),
          kind: key ? "related-to" : ((payload.kind ?? "member-of") as Link["kind"]),
          ...(key ? { role: "key" } : payload.role === undefined ? {} : { role: payload.role }),
          ...(key || payload.purpose === undefined ? {} : { purpose: payload.purpose }),
          ...(key || payload.position === undefined ? {} : { position: payload.position }),
          ...(key || payload.roleNote === undefined ? {} : { roleNote: payload.roleNote }),
          ...(key || payload.engagement === undefined ? {} : { engagement: payload.engagement }),
          ...(key || payload.startsAt === undefined ? {} : { startsAt: payload.startsAt }),
          ...(key || payload.endsAt === undefined ? {} : { endsAt: payload.endsAt }),
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

/** What to set on a relationship; `null` clears one. Times are UTC ms, `endsAt` exclusive. */
export interface RelationUpdate {
  role?: string | null
  purpose?: string | null
  position?: string | null
  roleNote?: string | null
  engagement?: Engagement | null
  startsAt?: number | null
  endsAt?: number | null
}

const timeOf = (value: number, what: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new CliError("validation_error", `${what} is UTC milliseconds`)
  return value
}

/** A relationship ends after it starts. */
export const spanOf = (startsAt: number | null | undefined, endsAt: number | null | undefined): void => {
  if (startsAt != null && endsAt != null && endsAt <= startsAt)
    throw new CliError("validation_error", "a relationship ends after it starts")
}

/** The relationship fields kept in `links.metadata`. */
const METADATA_FIELDS = ["position", "roleNote", "engagement"] as const

export const roleNoteOf = (note: string): string => {
  const value = note.trim()
  if (!value || value.length > 200) throw new CliError("validation_error", "a role note takes 1–200 characters")
  return value
}

export const positionOf = (position: string): string => {
  const value = position.trim()
  if (!value || value.length > 200) throw new CliError("validation_error", "a position takes 1–200 characters")
  return value
}

/** What a relationship update sets, checked; `null` clears a field and an absent one is left alone. */
const changesOf = (input: RelationUpdate): RelationUpdate => {
  const changes: RelationUpdate = {}
  if (input.role !== undefined) changes.role = input.role === null ? null : roleOf(input.role)
  if (input.purpose !== undefined) changes.purpose = input.purpose === null ? null : purposeOf(input.purpose)
  if (input.position !== undefined) changes.position = input.position === null ? null : positionOf(input.position)
  if (input.roleNote !== undefined) changes.roleNote = input.roleNote === null ? null : roleNoteOf(input.roleNote)
  if (input.engagement !== undefined) changes.engagement = input.engagement
  if (input.startsAt !== undefined)
    changes.startsAt = input.startsAt === null ? null : timeOf(input.startsAt, "a start")
  if (input.endsAt !== undefined) changes.endsAt = input.endsAt === null ? null : timeOf(input.endsAt, "an end")
  if (!Object.keys(changes).length)
    throw new CliError(
      "validation_error",
      "a relationship update sets a role, a role note, an engagement level, a purpose, a position or its dates",
    )
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
