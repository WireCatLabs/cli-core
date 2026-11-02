import { CliError } from "@wirecat/cli-base"
import { type Decider, proposerOfProvenance } from "../../../store/decisions.js"
import type { Link, LinkInput, MessageStore, ProposedAction } from "../../../store/index.js"
import { proposerOfAction } from "../../../store/index.js"
import type { Decided, ProposalKind, ProposalRow } from "../types.js"
import { actionStatus, kept, proposedLink, reading, storedStatus } from "./shared.js"

type KeyDocumentStore = Pick<MessageStore, "notes" | "proposedActions">

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
  proposedBy: proposerOfProvenance(link.provenance),
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

/** The confirmed key link, recording an agent that decided for the owner. */
const keyLink = (ref: string, project: string, reason: string | null, by: Decider): LinkInput => ({
  from: ref,
  to: project,
  kind: "related-to",
  role: "key",
  ...(reason === null ? {} : { evidence: reason }),
  ...(by === "owner"
    ? { origin: "owner" as const }
    : {
        origin: "suggested" as const,
        confirmed: true,
        provenance: `agent:${by.bot} for the owner: ${by.reason}`,
      }),
})

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
        limit: reading(filter),
      })
      const links = (filter.status ?? "proposed") === "rejected" ? [] : await legacy()
      return kept([...stored.map(storedRow), ...links.map(linkRow)], filter)
    },
    get: async (id) =>
      id.startsWith("key:") ? linkRow(await legacyLink(id)) : storedRow(await store.proposedActions.get(id)),
    decide: async (id, { confirm, by }): Promise<Decided> => {
      const status = confirm ? "confirmed" : "rejected"
      if (id.startsWith("key:")) {
        const link = await legacyLink(id)
        // A link has no confirm of its own: the suggestion is replaced by a confirmed link naming the decider.
        await store.notes.removeLink(link.id)
        if (!confirm) return { id, kind: "key_document", status, made: [] }
        const made = await store.notes.addLink(keyLink(link.from, String(link.to), link.evidence, by))
        return { id, kind: "key_document", status, made: [`link:${made.id}`] }
      }
      if (!confirm) {
        await store.proposedActions.reject(id, by)
        return { id, kind: "key_document", status, made: [] }
      }
      const action = await store.proposedActions.get(id)
      const payload = action.payload as Payload
      const made = await store.notes.addLink(keyLink(payload.ref, payload.project, action.reason, by))
      await store.proposedActions.approve(id, by, { link: made.id })
      return { id, kind: "key_document", status, made: [`link:${made.id}`] }
    },
  }
}
