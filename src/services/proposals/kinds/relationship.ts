import { CliError } from "@wirecat/cli-base"
import { type Decider, proposerOfProvenance } from "../../../store/decisions.js"
import type { Link, MessageStore, ProposedAction } from "../../../store/index.js"
import { proposerOfAction } from "../../../store/index.js"
import type { Decided, ProposalKind, ProposalRow } from "../types.js"
import { actionStatus, kept, projectOf, proposedLink, reading, storedStatus } from "./shared.js"

type RelationshipStore = Pick<MessageStore, "knowledge" | "notes" | "proposedActions">

interface Payload {
  from: string
  to: string
  kind: "member-of" | "related-to"
  role?: string
  evidence?: string[]
  score?: number
  signals?: ProposalRow["signals"]
}

const linkRow = (link: Link): ProposalRow => ({
  id: `link:${link.id}`,
  kind: "relationship",
  status: "proposed",
  project: projectOf(link.to, link.from),
  subject: link.from,
  object: link.to,
  summary: link.role,
  proposedBy: proposerOfProvenance(link.provenance),
  reason: link.evidence,
  evidence: [],
  score: null,
  signals: null,
  parts: null,
  createdAt: link.createdAt,
})

const storedRow = (action: ProposedAction): ProposalRow => {
  const payload = action.payload as Payload
  return {
    id: action.id,
    kind: "relationship",
    status: actionStatus(action.status),
    project: projectOf(payload.to, payload.from),
    subject: payload.from,
    object: payload.to,
    summary: payload.role ?? null,
    proposedBy: proposerOfAction(action),
    reason: action.reason,
    evidence: (payload.evidence ?? []).slice(0, 5),
    score: payload.score ?? null,
    signals: payload.signals ?? null,
    parts: null,
    createdAt: action.createdAt,
  }
}

const agentProvenance = (by: Decider) =>
  by === "owner" ? {} : { provenance: `agent:${by.bot} for the owner: ${by.reason}` }

/**
 * A person, organization, chat or mail thread proposed as related to another thing. New proposals are stored
 * `relationship` rows; suggestions written before them are unconfirmed links, shown as `link:<id>` until the store
 * moves them.
 */
export const relationshipKind = (store: RelationshipStore): ProposalKind => {
  const legacy = async (): Promise<Link[]> => {
    const [members, related] = await Promise.all([
      store.notes.links({ kind: "member-of", confirmed: false }),
      store.notes.links({ kind: "related-to", confirmed: false }),
    ])
    return [...members, ...related].filter(
      (link) => link.to !== null && link.role !== "key" && proposedLink(link.provenance),
    )
  }
  const legacyLink = async (id: string): Promise<Link> => {
    const link = (await legacy()).find((one) => `link:${one.id}` === id)
    if (!link) throw new CliError("not_found", `no proposed relationship ${id}`)
    return link
  }
  return {
    kind: "relationship",
    prefix: "link",
    stored: ["relationship"],
    list: async (filter) => {
      const status = storedStatus(filter)
      const stored = await store.proposedActions.list({
        kinds: ["relationship"],
        ...(status === undefined ? {} : { status }),
        limit: reading(filter),
      })
      const links = (filter.status ?? "proposed") === "rejected" ? [] : await legacy()
      return kept([...stored.map(storedRow), ...links.map(linkRow)], filter)
    },
    get: async (id) =>
      id.startsWith("link:") ? linkRow(await legacyLink(id)) : storedRow(await store.proposedActions.get(id)),
    decide: async (id, { confirm, by }): Promise<Decided> => {
      const status = confirm ? "confirmed" : "rejected"
      if (id.startsWith("link:")) {
        const link = id.slice("link:".length)
        if (!confirm) {
          await store.knowledge.removeRelation(null, link, by)
          return { id, kind: "relationship", status, made: [] }
        }
        await store.knowledge.confirmRelation(null, link, by)
        return { id, kind: "relationship", status, made: [`relationship:${link}`] }
      }
      if (!confirm) {
        await store.proposedActions.reject(id, by)
        return { id, kind: "relationship", status, made: [] }
      }
      const payload = (await store.proposedActions.get(id)).payload as Payload
      const relation = await store.knowledge.relate(null, {
        from: payload.from,
        to: payload.to,
        kind: payload.kind,
        ...(payload.role === undefined ? {} : { role: payload.role }),
        ...agentProvenance(by),
      })
      await store.proposedActions.approve(id, by, { link: relation.id })
      return { id, kind: "relationship", status, made: [`relationship:${relation.id}`] }
    },
  }
}
