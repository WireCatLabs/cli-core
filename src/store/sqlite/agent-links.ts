import { CliError } from "@wirecat/cli-base"
import { isNoReplyAddress, isRoleAddress } from "../../domain/addresses.js"
import { isMobilePhone } from "../../domain/phones.js"
import {
  type AgentLink,
  type AgentLinkInput,
  type AgentMerge,
  IDENTITY_LINK_KIND,
  type IdentityLinkPayload,
  type LinkEvidence,
  type LinkFact,
  type LinkHold,
  type LinkWeakness,
} from "../identity-links.js"
import { rejectedEvidence, sidesOf } from "./identity-link-rows.js"
import { openIdentityLink } from "./identity-proposals.js"
import type { StoreContext } from "./open.js"
import { isOwner, mergePerson, recordOf, required, survivorOf } from "./person-links.js"
import {
  emailHolders,
  type Holder,
  type Holders,
  oneHolderPerSource,
  phoneHolders,
  phonePairJoins,
  sharedLine,
} from "./person-match-scan.js"
import { mergeId, merges } from "./person-merges.js"
import { resolvePersonLinks } from "./person-resolution.js"
import { separated } from "./person-separation.js"
import { proposalOperationsOver, proposerOfAction } from "./proposed-actions.js"
import { write } from "./transaction.js"

/** An agent's merge moves identities as `agent:<name>`, never as a bare name an agent could set to `owner`. */
const AGENT_METHOD = "agent"

const personsOf = ({ database }: StoreContext): Map<number, number> =>
  new Map(
    database
      .prepare("SELECT identity_id, person_id FROM identity_links")
      .all()
      .map((row) => [Number(row.identity_id), Number(row.person_id)]),
  )

const weaknessOf = (
  context: StoreContext,
  kind: LinkFact["kind"],
  value: string,
  holders: Holder[],
  sides: [Holder[], Holder[]],
  others: number,
): LinkWeakness | null => {
  if (kind === "email" && isNoReplyAddress(value)) return "no-reply"
  if (kind === "email" && isRoleAddress(value)) return "role-address"
  if (sharedLine(context, holders)) return "company"
  if (others > 0 && !oneHolderPerSource(holders)) return "shared"
  if (kind === "phone" && !isMobilePhone(value)) return "landline"
  const [one, other] = sides
  if (!one.some((a) => other.some((b) => a.provider !== b.provider))) return "one-source"
  if (kind === "phone" && !phonePairJoins(value, holders)) return "not-own-number"
  return null
}

/**
 * Reads every phone and address once, then answers for any number of pairs of people: what they share, and whether it
 * is strong enough for an agent to merge them.
 */
export const linkEvidenceOver = (context: StoreContext): ((a: number, b: number) => LinkEvidence) => {
  let read: { holders: [LinkFact["kind"], Holders][]; persons: Map<number, number> } | undefined
  return (a, b) => {
    read ??= {
      holders: [
        ["phone", phoneHolders(context.database)],
        ["email", emailHolders(context.database)],
      ],
      persons: personsOf(context),
    }
    const { holders: all, persons } = read
    const facts: LinkFact[] = []
    for (const [kind, holders] of all)
      for (const [value, held] of holders) {
        const on = (person: number) => held.filter(({ identity }) => persons.get(identity) === person)
        const sides: [Holder[], Holder[]] = [on(a), on(b)]
        if (sides[0].length === 0 || sides[1].length === 0) continue
        const people = new Set(held.map(({ identity }) => persons.get(identity)).filter((p) => p !== undefined))
        const others = people.size - 2
        const weak = weaknessOf(context, kind, value, held, sides, others)
        const refs = (side: Holder[]) => side.map(({ provider, externalId }) => `${provider}:${externalId}`)
        facts.push({ kind, value, holders: [refs(sides[0]), refs(sides[1])], others, strong: weak === null, weak })
      }
    facts.sort((x, y) => Number(y.strong) - Number(x.strong))
    const strong = facts.some((fact) => fact.strong)
    return {
      persons: [`person:${a}`, `person:${b}`],
      strong,
      facts,
      weak: strong ? null : (facts[0]?.weak ?? "nothing-shared"),
    }
  }
}

const held = (evidence: LinkEvidence, weak: LinkHold): LinkEvidence => ({ ...evidence, strong: false, weak })

/**
 * An agent's link: merged at once on strong evidence the store finds itself, recorded as an `identity_link` decided by
 * the agent, with the evidence, its reason and its run; otherwise it waits for the owner as a proposal, which says why
 * it is not strong. Refused over the owner's separation, as any agent's link is.
 */
export const agentLink = (context: StoreContext, input: AgentLinkInput): AgentLink =>
  write(context.database, () => {
    const bot = input.bot.trim()
    if (!bot || bot === "owner")
      throw new CliError("validation_error", "an agent's link names the agent", { reason: "identity.agent-unnamed" })
    const identity = required(context, input.identity)
    const other = required(context, input.with)
    const [from, to] = [identity.personPk, other.personPk]
    if (from === to)
      throw new CliError("validation_error", "those identities are one person already", { reason: "identity.same" })
    if (separated(context, from, to))
      throw new CliError("conflict", "the owner separated these people; only the owner links them again", {
        reason: "identity.separated",
      })
    const found = linkEvidenceOver(context)(from, to)
    const hold: LinkHold | undefined = !input.apply
      ? "propose-only"
      : isOwner(context, from) || isOwner(context, to)
        ? "owner"
        : rejectedEvidence(context.database, from, to) !== undefined
          ? "rejected"
          : undefined
    const evidence = hold === undefined || !found.strong ? found : held(found, hold)
    const run = input.run?.trim() ? { run: input.run.trim() } : {}
    const by = { bot, kind: "agent" as const }
    const operations = proposalOperationsOver(context)
    if (!evidence.strong) {
      const opened = openIdentityLink(context, {
        identity: identity.pk,
        with: other.pk,
        from,
        to,
        joins: "person",
        signal: "agent",
        by,
        reason: input.reason,
        evidence: evidence.facts.map(({ value }) => value),
        strength: evidence,
        ...run,
      })
      if (opened.outcome === "skipped")
        throw new CliError(
          "conflict",
          opened.reason === "identity.rejected"
            ? "the owner rejected linking these people on this evidence; only new evidence proposes them again"
            : "those identities are one person already",
          { reason: opened.reason },
        )
      return { outcome: "proposed", proposal: opened.action.id, evidence }
    }
    const [fact] = evidence.facts as [LinkFact]
    const kept = survivorOf(context, from, to)
    const merge = mergeId(kept, kept === to ? from : to)
    const payload: IdentityLinkPayload = {
      identity: `${input.identity.provider}:${input.identity.id}`,
      with: `${input.with.provider}:${input.with.id}`,
      persons: [String(from), String(to)],
      sides: sidesOf(context.database, from, to),
      joins: "person",
      signal: fact.kind,
      score: null,
      evidence: [fact.value],
      strength: evidence,
      applied: "agent",
      ...run,
    }
    const proposal = operations.propose({ kind: IDENTITY_LINK_KIND, by, payload, reason: input.reason })
    operations.approve(proposal.id, { person: String(kept), merge }, by)
    mergePerson(context, from, to, { method: AGENT_METHOD, by: `agent:${bot}` })
    resolvePersonLinks(
      context.database,
      recordOf(context, kept).identities.flatMap(({ name, username }) => [name, username]),
    )
    return { outcome: "merged", person: `person:${kept}`, merge, proposal: proposal.id, evidence }
  })

/** Who merged, why and in which run, for a merge an agent made; `undefined` for any other. */
export const agentMergeOf = (context: StoreContext, merge: string): AgentMerge | undefined => {
  const row = context.database
    .prepare(
      "SELECT id FROM proposed_actions WHERE kind = ? AND status = 'approved' " +
        "AND json_extract(payload, '$.applied') = 'agent' AND json_extract(result, '$.merge') = ? ORDER BY id DESC LIMIT 1",
    )
    .get(IDENTITY_LINK_KIND, merge)
  if (!row) return undefined
  const action = proposalOperationsOver(context).get(String(row.id))
  const payload = action.payload as IdentityLinkPayload
  const proposer = proposerOfAction(action)
  return {
    proposal: action.id,
    bot: proposer.type === "agent" ? proposer.name : "unknown",
    run: payload.run ?? null,
    reason: action.reason,
    evidence: payload.strength ?? null,
  }
}

/** The merges agents made that are still in place, newest first: what the owner may want to undo. */
export const agentMerges = (context: StoreContext, { limit, offset }: { limit: number; offset: number }) => {
  const rows = context.database
    .prepare(
      "SELECT json_extract(result, '$.merge') AS merge FROM proposed_actions WHERE kind = ? AND status = 'approved' " +
        "AND json_extract(payload, '$.applied') = 'agent' ORDER BY id DESC",
    )
    .all(IDENTITY_LINK_KIND)
  const found = []
  for (const { merge } of rows) {
    const [, to] = /^merge:(\d+)-\d+$/.exec(String(merge)) ?? []
    if (to === undefined) continue
    const inPlace = merges(context, to).find((one) => one.id === merge && one.method === AGENT_METHOD)
    if (inPlace) found.push({ ...inPlace, agent: agentMergeOf(context, inPlace.id) as AgentMerge })
  }
  return { items: found.slice(offset, offset + limit), hasMore: found.length > offset + limit }
}
