import { CliError } from "@wirecat/cli-base"
import { assertMayDecide, deciderAuthor } from "../decisions.js"
import type { CacheDatabase } from "../driver.js"
import {
  IDENTITY_SPLIT_KIND,
  type IdentitySplitDecision,
  type IdentitySplitFilter,
  type IdentitySplitInput,
  type IdentitySplitMove,
  type IdentitySplitPayload,
  type IdentitySplitRow,
} from "../identity-splits.js"
import type { IdentityRef, PersonRecord } from "../types.js"
import { sideOf } from "./identity-link-rows.js"
import { parseIdentityRef } from "./identity-proposals.js"
import { currentPerson } from "./merged-persons.js"
import type { StoreContext } from "./open.js"
import { recordOf, required, unlinkIdentity } from "./person-links.js"
import { mergeId, merges, parseMergeId, split, undoMerge } from "./person-merges.js"
import { type ProposedAction, proposalOperationsOver, proposerOfAction } from "./proposed-actions.js"
import { write } from "./transaction.js"

const refOf = ({ provider, id }: IdentityRef): string => `${provider}:${id}`

interface Plan {
  split: IdentitySplitMove
  person: number
  identities: string[]
  merge: string | null
}

const keyOf = (person: number, identities: readonly string[]): string => `${person} ${[...identities].sort().join(" ")}`

/** What the split would move, checked as the owner's own move would check it, so a proposal can be carried out. */
const planOf = (context: StoreContext, input: IdentitySplitInput): Plan => {
  if ("merge" in input) {
    const { to, from } = parseMergeId(input.merge)
    const id = mergeId(to, from)
    const found = merges(context, to).find((merge) => merge.id === id)
    if (found === undefined)
      throw new CliError("not_found", `nothing of person:${from} is merged into person:${to}`, {
        reason: "identity.no-merge",
      })
    return { split: "unmerge", person: Number(to), identities: found.identities.map(refOf), merge: id }
  }
  const chosen = [...new Map(input.identities.map((ref) => [refOf(ref), ref])).values()]
  if (chosen.length === 0) throw new CliError("validation_error", "name at least one identity to split off")
  const persons = new Set(chosen.map((ref) => required(context, ref).personPk))
  if (persons.size > 1)
    throw new CliError("validation_error", "the identities that leave are all of one person", {
      reason: "identity.several-persons",
    })
  const person = [...persons][0] as number
  if (chosen.length >= recordOf(context, person).identities.length)
    throw new CliError("validation_error", "a split leaves at least one identity with the person", {
      reason: "identity.nothing-left",
    })
  return { split: "unlink", person, identities: chosen.map(refOf), merge: null }
}

interface SplitRowStored {
  id: string
  status: string
  payload: IdentitySplitPayload
}

const splitRows = (
  database: CacheDatabase,
  statuses: readonly string[],
  page?: { limit: number; offset: number },
): SplitRowStored[] =>
  database
    .prepare(
      "SELECT id, status, payload FROM proposed_actions WHERE kind = ? AND status IN (SELECT value FROM json_each(?)) " +
        `ORDER BY id DESC${page === undefined ? "" : " LIMIT ? OFFSET ?"}`,
    )
    .all(IDENTITY_SPLIT_KIND, JSON.stringify(statuses), ...(page === undefined ? [] : [page.limit, page.offset]))
    .map((row) => ({
      id: String(row.id),
      status: String(row.status),
      payload: JSON.parse(String(row.payload)) as IdentitySplitPayload,
    }))

const identityPk = (database: CacheDatabase, ref: string): number | undefined => {
  const { provider, id } = parseIdentityRef(ref)
  const row = database.prepare("SELECT id FROM identities WHERE provider = ? AND external_id = ?").get(provider, id)
  return row ? Number(row.id) : undefined
}

/** The person a proposal's first identity is on now; merges since may have moved it. */
const personNow = (database: CacheDatabase, payload: IdentitySplitPayload): number => {
  const pk = payload.identities[0] === undefined ? undefined : identityPk(database, payload.identities[0])
  const row =
    pk === undefined
      ? undefined
      : database.prepare("SELECT person_id FROM identity_links WHERE identity_id = ?").get(pk)
  return row ? Number(row.person_id) : currentPerson(database, Number(payload.person))
}

/**
 * The identities the owner turned a split down for, by the person they are on now: the owner said they belong there.
 * `people doubts` leaves them out.
 */
export const keptTogether = (database: CacheDatabase): Map<number, Set<string>> => {
  const kept = new Map<number, Set<string>>()
  for (const { payload } of splitRows(database, ["rejected"])) {
    const person = personNow(database, payload)
    const refs = kept.get(person) ?? new Set<string>()
    for (const ref of payload.identities) refs.add(ref)
    kept.set(person, refs)
  }
  return kept
}

/**
 * Proposes to take identities off their person, or to undo a merge, as an `identity_split` only the owner decides. An
 * open proposal for the same identities is given back instead of a second; one the owner turned down is refused.
 */
export const proposeIdentitySplit = (context: StoreContext, input: IdentitySplitInput): ProposedAction =>
  write(context.database, () => {
    const reason = input.reason.trim()
    if (!reason)
      throw new CliError("validation_error", "a proposal to split a person says why", {
        reason: "proposal.reason-required",
      })
    const plan = planOf(context, input)
    const key = keyOf(plan.person, plan.identities)
    const operations = proposalOperationsOver(context)
    for (const row of splitRows(context.database, ["proposed", "rejected"])) {
      if (keyOf(personNow(context.database, row.payload), row.payload.identities) !== key) continue
      if (row.status === "proposed") return operations.get(row.id)
      throw new CliError("conflict", "the owner kept these identities together; only the owner splits them", {
        reason: "identity.kept-together",
      })
    }
    const payload: IdentitySplitPayload = {
      split: plan.split,
      person: String(plan.person),
      identities: plan.identities,
      merge: plan.merge,
      side: sideOf(context.database, plan.person),
      evidence: input.evidence ?? [],
    }
    return operations.propose({ kind: IDENTITY_SPLIT_KIND, by: input.by, payload, reason })
  })

/**
 * Decides an `identity_split`, the owner's alone. Confirm carries it out as the owner's own unlink or unmerge, so no
 * automatic match joins them again; it is refused with `identity.stale` when the person changed since it was proposed.
 * Only a waiting proposal is carried out: one an older build approved as a plain action stays as it is.
 */
export const decideIdentitySplit = (
  context: StoreContext,
  id: string,
  decision: IdentitySplitDecision,
): ProposedAction =>
  write(context.database, () => {
    const operations = proposalOperationsOver(context)
    const proposal = operations.get(id)
    if (proposal.kind !== IDENTITY_SPLIT_KIND)
      throw new CliError("validation_error", `${id} is a ${proposal.kind} proposal, not a split of a person`)
    assertMayDecide(
      { id, kind: IDENTITY_SPLIT_KIND, ownerOnly: true, proposedBy: proposerOfAction(proposal) },
      decision.by,
      context.decisions,
    )
    const author = deciderAuthor(decision.by)
    const reason = decision.reason?.trim() || undefined
    const noted = reason === undefined ? {} : { reason }
    if (!decision.confirm) return operations.reject(id, author, noted)
    if (proposal.status !== "proposed")
      throw new CliError("validation_error", `${id} is already ${proposal.status}`, { reason: "proposal.wrong-state" })
    const payload = proposal.payload as IdentitySplitPayload
    const person = Number(payload.person)
    const refs = payload.identities.map(parseIdentityRef)
    const moved = refs.some((ref) => {
      const pk = identityPk(context.database, refOf(ref))
      return pk === undefined || required(context, ref).personPk !== person
    })
    if (moved || sideOf(context.database, person) !== payload.side)
      throw new CliError("conflict", `the person ${id} names changed since it was proposed; propose it again`, {
        reason: "identity.stale",
      })
    const owner = { method: "unlink", by: "owner" }
    let made: PersonRecord
    if (payload.split === "unmerge") {
      const { to, from } = parseMergeId(payload.merge ?? "")
      made = undoMerge(context, to, from, "owner")
    } else
      made =
        refs.length === 1
          ? unlinkIdentity(context, refs[0] as IdentityRef, owner)
          : split(context, String(person), refs, "owner")
    return operations.approve(id, { person: made.uid, ...noted }, author)
  })

const SHOWN: Record<string, IdentitySplitRow["status"]> = {
  proposed: "proposed",
  rejected: "rejected",
  approved: "confirmed",
  executed: "confirmed",
  failed: "confirmed",
}

/** The `identity_split` proposals, newest first, each naming the person as they are now. */
export const identitySplitRows = (
  context: StoreContext,
  { status = "proposed", limit, offset }: IdentitySplitFilter,
): { items: IdentitySplitRow[]; hasMore: boolean } => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new CliError("validation_error", "a list of split proposals takes 1–500 items")
  const statuses = Object.keys(SHOWN).filter((one) => status === "all" || SHOWN[one] === status)
  const operations = proposalOperationsOver(context)
  const rows = splitRows(context.database, statuses, { limit: limit + 1, offset })
  const items = rows.slice(0, limit).map((row): IdentitySplitRow => {
    const action = operations.get(row.id)
    return {
      id: row.id,
      status: SHOWN[row.status] ?? "proposed",
      split: row.payload.split,
      person: `person:${personNow(context.database, row.payload)}`,
      identities: row.payload.identities,
      merge: row.payload.merge,
      reason: action.reason,
      evidence: row.payload.evidence,
      proposedBy: proposerOfAction(action),
      createdAt: action.createdAt,
    }
  })
  return { items, hasMore: rows.length > limit }
}

/** Deletes every `identity_split` that names an identity no longer in the store: its payload names the address. */
export const forgetErasedSplits = (database: CacheDatabase): void => {
  for (const row of splitRows(database, ["proposed", "approved", "rejected", "executed", "failed"]))
    if (row.payload.identities.some((ref) => identityPk(database, ref) === undefined))
      database.prepare("DELETE FROM proposed_actions WHERE id = ?").run(Number(row.id))
}
