import { CliError } from "@wirecat/cli-base"
import type { Link, MessageStore, ProposedAction } from "../../../store/index.js"
import { proposerOfAction } from "../../../store/index.js"
import type { Decided, ProposalKind, ProposalRow } from "../types.js"
import { actionStatus, kept, proposedLink, pushed, storedStatus } from "./shared.js"

type KeyDocumentStore = Pick<MessageStore, "knowledge" | "notes" | "proposedActions">

interface Payload {
  ref: string
  project: string
  reason?: string
}

const linkRow = (link: Link): ProposalRow => ({
  id: `key:${link.id}`,
  kind: "key_document",
  status: "proposed",
  project: link.to,
  subject: link.from,
  object: link.to,
  summary: null,
  proposedBy: { type: "unknown" },
  reason: link.evidence,
  evidence: [link.from],
  score: null,
  signals: null,
  parts: null,
  createdAt: link.createdAt,
})

const storedRow = (action: ProposedAction): ProposalRow => {
  const payload = action.payload as Payload
  return {
    id: action.id,
    kind: "key_document",
    status: actionStatus(action.status),
    project: payload.project,
    subject: payload.ref,
    object: payload.project,
    summary: null,
    proposedBy: proposerOfAction(action),
    reason: action.reason ?? payload.reason ?? null,
    evidence: [payload.ref],
    score: null,
    signals: null,
    parts: null,
    createdAt: action.createdAt,
  }
}

/**
 * A note, document or message proposed as one of a project's key documents. Stored `key_document` rows are the new
 * home; older suggestions are unconfirmed `key` links, shown as `key:<id>`.
 */
export const keyDocumentKind = (store: KeyDocumentStore): ProposalKind => {
  const legacy = async (): Promise<Link[]> =>
    (await store.notes.links({ kind: "related-to", role: "key", confirmed: false })).filter(
      (link) => link.to?.startsWith("project:") && proposedLink(link.provenance),
    )
  const legacyLink = async (id: string): Promise<Link> => {
    const link = (await legacy()).find((one) => `key:${one.id}` === id)
    if (!link) throw new CliError("not_found", `no suggested key document ${id}`)
    return link
  }
  return {
    kind: "key_document",
    prefix: "key",
    stored: ["key_document"],
    list: async (filter) => {
      const status = storedStatus(filter)
      const stored = await store.proposedActions.list({
        kinds: ["key_document"],
        ...(status === undefined ? {} : { status }),
        ...pushed(filter),
      })
      const links = (filter.status ?? "proposed") === "rejected" ? [] : await legacy()
      return kept([...stored.map(storedRow), ...links.map(linkRow)], filter)
    },
    get: async (id) =>
      id.startsWith("key:") ? linkRow(await legacyLink(id)) : storedRow(await store.proposedActions.get(id)),
    decide: async (id, { confirm, by, reason }): Promise<Decided> => {
      const status = confirm ? "confirmed" : "rejected"
      const decision = { confirm, by, ...(reason === undefined ? {} : { reason }) }
      const link = id.startsWith("key:")
        ? await store.knowledge.decideSuggestedLink(id.slice("key:".length), decision)
        : (await store.knowledge.decideLinkProposal(id, decision)).link
      return { id, kind: "key_document", status, made: link ? [`link:${link.id}`] : [] }
    },
  }
}
