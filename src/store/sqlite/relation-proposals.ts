import { CliError } from "@wirecat/cli-base"
import { type Decider, type Proposer, proposerOfProvenance } from "../decisions.js"
import { actorOfOrigin, botNamed, ownerPerson } from "./actors.js"
import type { Author } from "./memories.js"
import type { Link } from "./notes.js"
import type { StoreContext } from "./open.js"
import { type ProposedAction, proposalOperationsOver } from "./proposed-actions.js"
import { type Thing, thingOf } from "./things.js"
import { write } from "./transaction.js"

/** `relationship` proposals in `proposed_actions`: an agent's or a rule's, and the rejected ones a scan skips. */
export const relationProposalsOver = (context: StoreContext) => {
  const { database, now } = context
  const operations = proposalOperationsOver(context)
  return {
    /** A confirmed link is the owner's; an unconfirmed one names its proposer in its provenance. */
    proposerOfLink: (link: Link): Proposer =>
      link.confirmed ? { type: "person", id: String(ownerPerson(database).id) } : proposerOfProvenance(link.provenance),

    /** The same pending pair returns the proposal already held. */
    propose: (
      from: Thing,
      input: { from: string; to: string; kind: string; role?: string; evidence?: string[]; reason?: string },
      by: Exclude<Author, "owner">,
    ): ProposedAction => {
      const evidence = input.evidence ?? []
      if (!Array.isArray(evidence) || evidence.length > 5 || evidence.some((ref) => typeof ref !== "string"))
        throw new CliError("validation_error", "a relationship proposal cites up to 5 references")
      return write(database, () => {
        const held = database
          .prepare(
            "SELECT id FROM proposed_actions WHERE kind='relationship' AND status='proposed' AND target_type=? AND target_id=? " +
              "AND json_extract(payload,'$.to')=? AND json_extract(payload,'$.kind')=? ORDER BY id LIMIT 1",
          )
          .get(from.type, from.id, input.to, input.kind)
        if (held) return operations.get(String(held.id))
        return operations.propose({
          kind: "relationship",
          by,
          target: input.from,
          payload: {
            from: input.from,
            to: input.to,
            kind: input.kind,
            ...(input.role === undefined ? {} : { role: input.role }),
            evidence,
          },
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        })
      })
    },

    /** The rejected `relationship` proposal a removed link leaves behind, so a scan never proposes it again. */
    rejected: (link: Link, proposer: Proposer, by: Decider, reason: string): void => {
      const at = now()
      const proposed =
        proposer.type === "person"
          ? ownerPerson(database)
          : proposer.type === "bot"
            ? botNamed(database, proposer.name, at, proposer.kind)
            : actorOfOrigin(database, "agent")
      const decided = by === "owner" ? ownerPerson(database) : botNamed(database, by.bot, at)
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
          JSON.stringify({ reason: by === "owner" ? reason : `${reason}: ${by.reason.trim()}`, link: link.id }),
          at,
          at,
        )
    },
  }
}
