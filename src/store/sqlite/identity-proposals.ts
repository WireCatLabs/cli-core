import { CliError } from "@wirecat/cli-base"
import { assertMayDecide, deciderAuthor } from "../decisions.js"
import {
  IDENTITY_LINK_KIND,
  type IdentityLinkDecision,
  type IdentityLinkFilter,
  type IdentityLinkInput,
  type IdentityLinkPayload,
  type IdentityLinkRow,
  type IdentityLinkSignal,
} from "../identity-links.js"
import type { IdentityRef, LinkOptions } from "../types.js"
import { ensurePerson } from "./identities.js"
import { evidenceKeyOf, type LinkIndex, linkIndex, linkRows, settleLinks, sidesOf } from "./identity-link-rows.js"
import type { Author } from "./memories.js"
import { currentPerson } from "./merged-persons.js"
import type { StoreContext } from "./open.js"
import { linkIdentityToPerson, mergePerson, move, recordOf, required, survivorOf } from "./person-links.js"
import { resolvePersonLinks } from "./person-resolution.js"
import { identitySeparated, separated } from "./person-separation.js"
import { type ProposedAction, proposalOperationsOver, proposerOfAction } from "./proposed-actions.js"
import { write } from "./transaction.js"

/** The method an owner's confirmed proposal links by. */
const CONFIRMED = "proposal"

export interface Opening {
  identity: number
  /** An identity of the person it would join, when that person has one. */
  with: number | null
  from: number
  to: number
  joins: IdentityLinkPayload["joins"]
  signal: IdentityLinkSignal
  by: Author
  reason?: string | undefined
  score?: number | undefined
  evidence?: string[] | undefined
  candidates?: number[] | undefined
}

export type Opened =
  | { outcome: "proposed" | "open"; action: ProposedAction }
  | { outcome: "skipped"; reason: "identity.same" | "identity.separated" | "identity.rejected" }

const refOf = ({ database }: StoreContext, pk: number): string => {
  const row = database.prepare("SELECT provider, external_id FROM identities WHERE id = ?").get(pk)
  return `${String(row?.provider)}:${String(row?.external_id)}`
}

/** `provider:id`; the provider never holds a colon, an id may. */
export const parseIdentityRef = (ref: string): IdentityRef => {
  const at = ref.indexOf(":")
  if (at < 1 || at === ref.length - 1)
    throw new CliError("validation_error", `${ref} is not an identity; it looks like telegram:12 or email:a@b.example`)
  return { provider: ref.slice(0, at), id: ref.slice(at + 1) }
}

const personOfIdentity = ({ database }: StoreContext, pk: number): number | undefined => {
  const row = database.prepare("SELECT person_id FROM identity_links WHERE identity_id = ?").get(pk)
  return row ? Number(row.person_id) : undefined
}

/**
 * Opens an `identity_link` proposal for two people, unless the owner separated them, one is already open for them, or
 * the owner rejected a proposal on this same evidence: then it says which. At most one proposal is open per pair.
 */
export const openIdentityLink = (context: StoreContext, opening: Opening, index?: LinkIndex): Opened =>
  write(context.database, () => {
    const { from, to } = opening
    if (from === to) return { outcome: "skipped", reason: "identity.same" }
    const apart =
      opening.joins === "identity" ? identitySeparated(context, opening.identity, to) : separated(context, from, to)
    if (apart) return { outcome: "skipped", reason: "identity.separated" }
    const operations = proposalOperationsOver(context)
    const links = index ?? linkIndex(context.database)
    const open = links.open(from, to)
    if (open) return { outcome: "open", action: operations.get(open.id) }
    const identity = refOf(context, opening.identity)
    const other = opening.with === null ? null : refOf(context, opening.with)
    if (links.rejected(from, to)?.has(evidenceKeyOf({ signal: opening.signal, identity, with: other })))
      return { outcome: "skipped", reason: "identity.rejected" }
    const payload: IdentityLinkPayload = {
      identity,
      with: other,
      persons: [String(from), String(to)],
      sides: sidesOf(context.database, from, to),
      joins: opening.joins,
      signal: opening.signal,
      score: opening.score ?? null,
      ...(opening.candidates && opening.candidates.length > 2 ? { candidates: opening.candidates.map(String) } : {}),
      evidence: opening.evidence ?? [],
    }
    const action = operations.propose({
      kind: IDENTITY_LINK_KIND,
      by: opening.by,
      payload,
      ...(opening.reason?.trim() ? { reason: opening.reason.trim() } : {}),
    })
    index?.add({ id: action.id, status: "proposed", payload, pair: [from, to] })
    return { outcome: "proposed", action }
  })

const refusalOf = (reason: "identity.same" | "identity.separated" | "identity.rejected"): CliError =>
  reason === "identity.same"
    ? new CliError("validation_error", "those identities are one person already", { reason })
    : reason === "identity.separated"
      ? new CliError("conflict", "the owner separated these people; only the owner links them again", { reason })
      : new CliError(
          "conflict",
          "the owner rejected linking these people on this evidence; only new evidence proposes them again",
          { reason },
        )

const firstIdentityOf = ({ database }: StoreContext, person: number): number | null => {
  const row = database
    .prepare("SELECT identity_id FROM identity_links WHERE person_id = ? ORDER BY identity_id LIMIT 1")
    .get(person)
  return row ? Number(row.identity_id) : null
}

/** Proposes that `with`'s person and `identity`'s person are one; the owner links directly instead. */
export const proposeIdentityLink = (context: StoreContext, input: IdentityLinkInput): ProposedAction => {
  const identity = required(context, input.identity)
  const other = required(context, input.with)
  const opened = openIdentityLink(context, {
    identity: identity.pk,
    with: other.pk,
    from: identity.personPk,
    to: other.personPk,
    joins: "person",
    signal: input.signal,
    by: input.by,
    reason: input.reason,
    score: input.score,
    evidence: input.evidence,
  })
  if (opened.outcome === "skipped") throw refusalOf(opened.reason)
  return opened.action
}

/**
 * Moves the identity to the person when the owner says so; anyone else's move waits as an `identity_link` proposal,
 * so an agent's mention or meeting association never replaces a link. Refused over the owner's separation, as
 * `linkIdentityToPerson` refuses. Gives the proposal's id when it opened or met one.
 */
export const linkOrPropose = (
  context: StoreContext,
  identity: number,
  target: number,
  options: LinkOptions,
): string | undefined => {
  if (options.by === "owner") {
    linkIdentityToPerson(context, identity, target, options)
    return undefined
  }
  const held = personOfIdentity(context, identity)
  if (held === target) return undefined
  if (identitySeparated(context, identity, target)) throw refusalOf("identity.separated")
  return write(context.database, () => {
    if (held === undefined) {
      const named = context.database.prepare("SELECT name FROM identities WHERE id = ?").get(identity)
      ensurePerson(context.orm, identity, named?.name == null ? null : String(named.name), context.now())
    }
    const opened = openIdentityLink(context, {
      identity,
      with: firstIdentityOf(context, target),
      from: personOfIdentity(context, identity) as number,
      to: target,
      joins: "identity",
      signal: "agent",
      by: { bot: options.by },
    })
    if (opened.outcome === "skipped") throw refusalOf(opened.reason)
    return opened.action.id
  })
}

/** The mentions an agent's proposal left `proposed` take the owner's answer: linked, or undecided again. */
const settleMentions = ({ database, now }: StoreContext, payload: IdentityLinkPayload, to: "linked" | "found") => {
  const { provider, id } = parseIdentityRef(payload.identity)
  const identity = database
    .prepare("SELECT id FROM identities WHERE provider = ? AND external_id = ?")
    .get(provider, id)
  if (!identity) return
  const cleared = to === "found" ? ", target_type = NULL, target_id = NULL" : ""
  database
    .prepare(
      `UPDATE mentions SET status = ?${cleared}, updated_at = ? WHERE status = 'proposed' AND target_type = 'identity' ` +
        "AND target_id = ?",
    )
    .run(to, now(), Number(identity.id))
}

/**
 * Decides an `identity_link`, the owner's alone. Confirm links the two people as the owner's link, refused with
 * `identity.stale` when either person changed since it was proposed; reject keeps them apart, and only new evidence
 * proposes the pair again.
 */
export const decideIdentityLink = (context: StoreContext, id: string, decision: IdentityLinkDecision): ProposedAction =>
  write(context.database, () => {
    const operations = proposalOperationsOver(context)
    const proposal = operations.get(id)
    if (proposal.kind !== IDENTITY_LINK_KIND)
      throw new CliError("validation_error", `${id} is a ${proposal.kind} proposal, not an identity link`)
    assertMayDecide(
      { id, kind: IDENTITY_LINK_KIND, ownerOnly: true, proposedBy: proposerOfAction(proposal) },
      decision.by,
      context.decisions,
    )
    const author = deciderAuthor(decision.by)
    const reason = decision.reason?.trim() || undefined
    const noted = reason === undefined ? {} : { reason }
    if (!decision.confirm) {
      const rejected = operations.reject(id, author, { dismissed: true, ...noted })
      settleMentions(context, proposal.payload as IdentityLinkPayload, "found")
      return rejected
    }
    if (proposal.status !== "proposed")
      throw new CliError("validation_error", `${id} is already ${proposal.status}`, { reason: "proposal.wrong-state" })
    const payload = proposal.payload as IdentityLinkPayload
    const identity = required(context, parseIdentityRef(payload.identity))
    const from = identity.personPk
    const to =
      payload.with === null
        ? currentPerson(context.database, Number(payload.persons[1]))
        : required(context, parseIdentityRef(payload.with)).personPk
    const [wasFrom, wasTo] = payload.persons
    if (
      String(from) !== wasFrom ||
      String(to) !== wasTo ||
      sidesOf(context.database, from, to).join("|") !== payload.sides.join("|")
    )
      throw new CliError("conflict", `the people ${id} names changed since it was proposed; propose it again`, {
        reason: "identity.stale",
      })
    const options = { method: CONFIRMED, by: "owner" }
    const kept = payload.joins === "person" ? survivorOf(context, from, to) : to
    // Approved first: the merge settles the proposals naming these people, and this one is decided, not moot.
    const approved = operations.approve(id, { person: String(kept), ...noted }, author)
    if (payload.joins === "person") mergePerson(context, from, to, options)
    else {
      move(context, identity.pk, from, to, options)
      settleLinks(context.database, [from, to])
    }
    resolvePersonLinks(
      context.database,
      recordOf(context, kept).identities.flatMap(({ name, username }) => [name, username]),
    )
    settleMentions(context, payload, "linked")
    return approved
  })

const SHOWN: Record<string, IdentityLinkRow["status"]> = {
  proposed: "proposed",
  rejected: "rejected",
  approved: "confirmed",
  executed: "confirmed",
  failed: "confirmed",
}

/** The `identity_link` proposals, newest first, each naming its people as they are now; a page and whether more follow. */
export const identityLinkRows = (
  context: StoreContext,
  { person, status = "proposed", limit, offset }: IdentityLinkFilter,
): { items: IdentityLinkRow[]; hasMore: boolean } => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new CliError("validation_error", "a list of link proposals takes 1–500 items")
  const asked = person === undefined ? undefined : currentPerson(context.database, Number(person))
  const operations = proposalOperationsOver(context)
  const rows = linkRows(context.database, ["proposed", "rejected", "approved", "executed", "failed"])
    .filter((row) => status === "all" || SHOWN[row.status] === status)
    .filter((row) => asked === undefined || (row.pair?.includes(asked) ?? false))
    .reverse()
  const items = rows.slice(offset, offset + limit).map((row): IdentityLinkRow => {
    const action = operations.get(row.id)
    const payload = row.payload
    const [from, to] = row.pair ?? payload.persons.map(Number)
    return {
      id: row.id,
      status: SHOWN[row.status] ?? "proposed",
      persons: [`person:${from}`, `person:${to}`],
      identity: payload.identity,
      with: payload.with,
      joins: payload.joins,
      signal: payload.signal,
      score: payload.score,
      candidates: (payload.candidates ?? []).map((uid) => `person:${uid}`),
      reason: action.reason,
      evidence: payload.evidence,
      proposedBy: proposerOfAction(action),
      createdAt: action.createdAt,
    }
  })
  return { items, hasMore: rows.length > offset + limit }
}
