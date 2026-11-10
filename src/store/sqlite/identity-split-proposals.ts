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
import { personOf, pkOf, sideOf } from "./identity-link-rows.js"
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

const keyOf = (split: IdentitySplitMove, person: number, identities: readonly string[]): string =>
  `${split} ${person} ${[...identities].sort().join(" ")}`

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
  made?: boolean,
): SplitRowStored[] =>
  database
    .prepare(
      "SELECT id, status, payload FROM proposed_actions WHERE kind = ? AND status IN (SELECT value FROM json_each(?)) " +
        (made === undefined ? "" : `AND json_extract(result, '$.person') IS ${made ? "NOT " : ""}NULL `) +
        `ORDER BY id DESC${page === undefined ? "" : " LIMIT ? OFFSET ?"}`,
    )
    .all(IDENTITY_SPLIT_KIND, JSON.stringify(statuses), ...(page === undefined ? [] : [page.limit, page.offset]))
    .map((row) => ({
      id: String(row.id),
      status: String(row.status),
      payload: JSON.parse(String(row.payload)) as IdentitySplitPayload,
    }))

/**
 * The person the proposal is about now: the one it was proposed for, or whom that person was merged into, while every
 * identity it names is still there. `undefined` once one left, was erased or went elsewhere.
 */
const holder = (database: CacheDatabase, payload: IdentitySplitPayload): number | undefined => {
  const person = currentPerson(database, Number(payload.person))
  return payload.identities.every((ref) => personOf(database, pkOf(database, ref)) === person) ? person : undefined
}

/**
 * The identities the owner turned a split down for, by the person they are still on: the owner said they belong there.
 * `people doubts` leaves them out. One that moved since counts no longer.
 */
export const keptTogether = (database: CacheDatabase): Map<number, Set<string>> => {
  const kept = new Map<number, Set<string>>()
  for (const { payload } of splitRows(database, ["rejected"])) {
    const person = currentPerson(database, Number(payload.person))
    for (const ref of payload.identities) {
      if (personOf(database, pkOf(database, ref)) !== person) continue
      const refs = kept.get(person) ?? new Set<string>()
      refs.add(ref)
      kept.set(person, refs)
    }
  }
  return kept
}

/**
 * Proposes to take identities off their person, or to undo a merge, as an `identity_split` only the owner decides. An
 * open proposal for the same identities is given back instead of a second, brought up to date with the person as it
 * is now and with the new evidence added, so proposing again is how a stale one is renewed; its first reason and
 * proposer stay. An identity the owner kept on this person by turning a split down is refused.
 */
export const proposeIdentitySplit = (context: StoreContext, input: IdentitySplitInput): ProposedAction =>
  write(context.database, () => {
    const reason = input.reason.trim()
    if (!reason)
      throw new CliError("validation_error", "a proposal to split a person says why", {
        reason: "proposal.reason-required",
      })
    const plan = planOf(context, input)
    const kept = keptTogether(context.database).get(plan.person)
    if (plan.identities.some((ref) => kept?.has(ref)))
      throw new CliError("conflict", "the owner kept these identities together; only the owner splits them", {
        reason: "identity.kept-together",
      })
    const key = keyOf(plan.split, plan.person, plan.identities)
    const operations = proposalOperationsOver(context)
    const payload: IdentitySplitPayload = {
      split: plan.split,
      person: String(plan.person),
      identities: plan.identities,
      merge: plan.merge,
      side: sideOf(context.database, plan.person),
      evidence: input.evidence ?? [],
    }
    for (const row of splitRows(context.database, ["proposed"])) {
      const person = holder(context.database, row.payload)
      if (person === undefined || keyOf(row.payload.split, person, row.payload.identities) !== key) continue
      const evidence = [...new Set([...row.payload.evidence, ...payload.evidence])]
      context.database
        .prepare("UPDATE proposed_actions SET payload = ? WHERE id = ?")
        .run(JSON.stringify({ ...payload, evidence }), Number(row.id))
      return operations.get(row.id)
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
    if (holder(context.database, payload) !== person || sideOf(context.database, person) !== payload.side)
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

/** A split carried out records the person it made; an older build's approval as a plain action made none. */
const shownStatus = (status: string, result: unknown): IdentitySplitRow["status"] => {
  if (status === "proposed" || status === "rejected") return status
  return typeof (result as { person?: unknown } | null)?.person === "string" ? "confirmed" : "dropped"
}

const STORED: Record<Exclude<IdentitySplitRow["status"], "dropped">, string[]> = {
  proposed: ["proposed"],
  rejected: ["rejected"],
  confirmed: ["approved", "executed", "failed"],
}

/** The `identity_split` proposals, newest first, each naming the person as they are now. */
export const identitySplitRows = (
  context: StoreContext,
  { status = "proposed", limit, offset }: IdentitySplitFilter,
): { items: IdentitySplitRow[]; hasMore: boolean } => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new CliError("validation_error", "a list of split proposals takes 1–500 items")
  const statuses = status === "all" ? Object.values(STORED).flat() : STORED[status === "dropped" ? "confirmed" : status]
  const made = status === "dropped" ? false : status === "confirmed" ? true : undefined
  const operations = proposalOperationsOver(context)
  const rows = splitRows(context.database, statuses, { limit: limit + 1, offset }, made)
  const items = rows.slice(0, limit).map((row): IdentitySplitRow => {
    const action = operations.get(row.id)
    return {
      id: row.id,
      status: shownStatus(row.status, action.result),
      split: row.payload.split,
      person: `person:${holder(context.database, row.payload) ?? currentPerson(context.database, Number(row.payload.person))}`,
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
    if (row.payload.identities.some((ref) => pkOf(database, ref) === undefined))
      database.prepare("DELETE FROM proposed_actions WHERE id = ?").run(Number(row.id))
}
