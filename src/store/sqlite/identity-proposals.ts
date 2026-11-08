import { CliError } from "@wirecat/cli-base"
import { assertMayDecide, deciderAuthor } from "../decisions.js"
import {
  IDENTITY_LINK_KIND,
  type IdentityLinkDecision,
  type IdentityLinkInput,
  type IdentityLinkPayload,
  type IdentityLinkSignal,
} from "../identity-links.js"
import type { IdentityRef, LinkOptions } from "../types.js"
import { ensurePerson } from "./identities.js"
import type { Author } from "./memories.js"
import { currentPerson } from "./merged-persons.js"
import type { StoreContext } from "./open.js"
import { linkIdentityToPerson, mergePerson, move, recordOf, required } from "./person-links.js"
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

const sideOf = ({ database }: StoreContext, person: number): string =>
  database
    .prepare("SELECT identity_id FROM identity_links WHERE person_id = ? ORDER BY identity_id")
    .all(person)
    .map(({ identity_id }) => String(identity_id))
    .join(",")

const pairOf = (a: number | string, b: number | string): string =>
  [Number(a), Number(b)].sort((x, y) => x - y).join("-")

const pkOf = ({ database }: StoreContext, ref: string): number | undefined => {
  const { provider, id } = parseIdentityRef(ref)
  const row = database.prepare("SELECT id FROM identities WHERE provider = ? AND external_id = ?").get(provider, id)
  return row ? Number(row.id) : undefined
}

/** The two people a stored proposal names now: merges since may have moved either side; a purge may have erased one. */
const currentPair = (context: StoreContext, payload: IdentityLinkPayload): string | undefined => {
  const identity = pkOf(context, payload.identity)
  const other = payload.with === null ? undefined : pkOf(context, payload.with)
  const from = identity === undefined ? undefined : personOfIdentity(context, identity)
  const to =
    payload.with === null
      ? currentPerson(context.database, Number(payload.persons[1]))
      : other === undefined
        ? undefined
        : personOfIdentity(context, other)
  return from === undefined || to === undefined ? undefined : pairOf(from, to)
}

const knownProposals = (context: StoreContext) =>
  context.database
    .prepare("SELECT id, status, payload FROM proposed_actions WHERE kind = ? AND status IN ('proposed', 'rejected')")
    .all(IDENTITY_LINK_KIND)
    .map((row) => ({ id: String(row.id), status: String(row.status), payload: JSON.parse(String(row.payload)) }))

/** The proposal the owner rejected for these two people, or else the one open for them. */
export const knownPair = (context: StoreContext, a: number, b: number): { id: string; status: string } | undefined => {
  const pair = pairOf(a, b)
  const found = knownProposals(context).filter(({ payload }) => {
    const named = payload as IdentityLinkPayload
    return pairOf(...named.persons) === pair || currentPair(context, named) === pair
  })
  return found.find(({ status }) => status === "rejected") ?? found[0]
}

/**
 * Opens an `identity_link` proposal for two people, unless the owner separated them, rejected the pair before, or one
 * is already open for it: then it says which. At most one proposal is open per pair of people.
 */
export const openIdentityLink = (context: StoreContext, opening: Opening): Opened =>
  write(context.database, () => {
    const { from, to } = opening
    if (from === to) return { outcome: "skipped", reason: "identity.same" }
    const apart =
      opening.joins === "identity" ? identitySeparated(context, opening.identity, to) : separated(context, from, to)
    if (apart) return { outcome: "skipped", reason: "identity.separated" }
    const operations = proposalOperationsOver(context)
    const known = knownPair(context, from, to)
    if (known?.status === "rejected") return { outcome: "skipped", reason: "identity.rejected" }
    if (known) return { outcome: "open", action: operations.get(known.id) }
    const payload: IdentityLinkPayload = {
      identity: refOf(context, opening.identity),
      with: opening.with === null ? null : refOf(context, opening.with),
      persons: [String(from), String(to)],
      sides: [sideOf(context, from), sideOf(context, to)],
      joins: opening.joins,
      signal: opening.signal,
      score: opening.score ?? null,
      ...(opening.candidates && opening.candidates.length > 2 ? { candidates: opening.candidates.map(String) } : {}),
      evidence: opening.evidence ?? [],
    }
    return {
      outcome: "proposed",
      action: operations.propose({
        kind: IDENTITY_LINK_KIND,
        by: opening.by,
        payload,
        ...(opening.reason?.trim() ? { reason: opening.reason.trim() } : {}),
      }),
    }
  })

const refusalOf = (reason: "identity.same" | "identity.separated" | "identity.rejected"): CliError =>
  reason === "identity.same"
    ? new CliError("validation_error", "those identities are one person already", { reason })
    : reason === "identity.separated"
      ? new CliError("conflict", "the owner separated these people; only the owner links them again", { reason })
      : new CliError("conflict", "the owner rejected linking these people; it is not proposed again", { reason })

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

/**
 * Decides an `identity_link`, the owner's alone. Confirm links the two people as the owner's link, refused with
 * `identity.stale` when either person changed since it was proposed; reject keeps them apart and the pair is not
 * proposed again.
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
    if (!decision.confirm) return operations.reject(id, author, { dismissed: true, ...noted })
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
      sideOf(context, from) !== payload.sides[0] ||
      sideOf(context, to) !== payload.sides[1]
    )
      throw new CliError("conflict", `the people ${id} names changed since it was proposed; propose it again`, {
        reason: "identity.stale",
      })
    const options = { method: CONFIRMED, by: "owner" }
    if (payload.joins === "person") mergePerson(context, from, to, options)
    else move(context, identity.pk, from, to, options)
    resolvePersonLinks(
      context.database,
      recordOf(context, to).identities.flatMap(({ name, username }) => [name, username]),
    )
    return operations.approve(id, { person: String(to), ...noted }, author)
  })
