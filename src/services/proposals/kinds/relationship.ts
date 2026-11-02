import { CliError } from "@wirecat/cli-base"
import type { Link, MessageStore, ProposedAction } from "../../../store/index.js"
import { proposerOfAction } from "../../../store/index.js"
import type { Decided, ProposalKind, ProposalRow } from "../types.js"
import { actionStatus, kept, projectOf, proposedLink, pushed, storedStatus } from "./shared.js"

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
  proposedBy: { type: "unknown" },
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
        ...pushed(filter),
      })
      const links = (filter.status ?? "proposed") === "rejected" ? [] : await legacy()
      return kept([...stored.map(storedRow), ...links.map(linkRow)], filter)
    },
    get: async (id) =>
      id.startsWith("link:") ? linkRow(await legacyLink(id)) : storedRow(await store.proposedActions.get(id)),
    decide: async (id, { confirm, by, reason }): Promise<Decided> => {
      const status = confirm ? "confirmed" : "rejected"
      const decision = { confirm, by, ...(reason === undefined ? {} : { reason }) }
      const link = id.startsWith("link:")
        ? await store.knowledge.decideSuggestedLink(id.slice("link:".length), decision)
        : (await store.knowledge.decideLinkProposal(id, decision)).link
      return { id, kind: "relationship", status, made: link ? [`relationship:${link.id}`] : [] }
    },
  }
}
