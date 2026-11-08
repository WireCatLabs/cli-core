import { CliError } from "@wirecat/cli-base"
import { MEETING_FINDINGS_KIND } from "../../meetings/index.js"
import { assertMayDecide, type Decider, deciderAuthor, type Proposer } from "../decisions.js"
import { EVIDENCE_FINDINGS_KIND } from "../evidence-findings.js"
import { MAIL_FINDINGS_KIND } from "../mail-findings.js"
import { SOURCE_REVIEW_KIND } from "../source-review.js"
import type { AccountKey } from "../types.js"
import { type Actor, type ProposedByFilter, proposedBySql } from "./actors.js"
import { type Author, authorActor } from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { referenceOfThing, storedThing } from "./things.js"
import { write } from "./transaction.js"

export const PROPOSAL_STATUSES = ["proposed", "approved", "rejected", "executed", "failed"] as const
export const PROPOSAL_VERDICTS = ["useful", "not_useful"] as const

/**
 * Something an agent wants done outside the store, waiting for a person. The store only keeps the
 * decision: a messenger adapter executes an approved action and reports back with `executed` or `failed`.
 * `payload` may hold a reply's text — the one place outgoing text waits — so it is shown to the approver
 * and never copied into the agent log.
 */
export interface ProposedAction {
  id: string
  kind: string
  account: AccountKey | null
  target: string | null
  payload: unknown
  reason: string | null
  status: (typeof PROPOSAL_STATUSES)[number]
  /** `name` is a bot's handle and `kind` whether it is an agent or a rule; both `null` for a person. */
  proposedBy: { type: Actor["type"]; id: string; name: string | null; kind: "agent" | "rule" | null }
  decidedBy: { type: Actor["type"]; id: string } | null
  decidedAt: string | null
  executedAt: string | null
  result: unknown
  error: string | null
  verdict: (typeof PROPOSAL_VERDICTS)[number] | null
  createdAt: string
}

export interface ProposalInput {
  kind: string
  by: Author
  account?: AccountKey
  target?: string
  payload?: unknown
  reason?: string
}

export interface ProposedActionsStore {
  propose(input: ProposalInput): Promise<ProposedAction>
  get(id: string): Promise<ProposedAction>
  /** What waits for a decision, oldest first. */
  pending(options?: { limit?: number }): Promise<ProposedAction[]>
  /** Newest first; every status unless one is named, every kind unless `kinds` names some or `except` leaves some out. */
  list(options?: {
    status?: ProposedAction["status"]
    limit?: number
    kinds?: readonly string[]
    except?: readonly string[]
    proposedBy?: ProposedByFilter
    /** A `project:<id>` the action targets or its payload names as `to`, `from` or `project`. */
    project?: string
  }): Promise<ProposedAction[]>
  /** `result` records what the approval made, such as the task it became. `by` must be allowed to decide it. */
  approve(id: string, by: Decider, result?: unknown): Promise<ProposedAction>
  /** `reason` is kept as the result: why it was turned down. */
  reject(id: string, by: Decider, reason?: string): Promise<ProposedAction>
  /** An approved action the adapter carried out, with what the provider answered. */
  executed(id: string, result?: unknown): Promise<ProposedAction>
  failed(id: string, error: string): Promise<ProposedAction>
  judge(id: string, verdict: ProposedAction["verdict"]): Promise<ProposedAction>
}

type Row = Record<string, unknown>
const iso = (value: unknown) => (value == null ? null : new Date(Number(value)).toISOString())
const json = (value: unknown) => (value == null ? null : JSON.parse(String(value)))

/**
 * A findings batch closed with nothing accepted is stored `approved`, as older builds read it; it reads as
 * `rejected`, the decision the owner made.
 */
const STATUS =
  `CASE WHEN p.status = 'approved' AND p.kind IN ('${MEETING_FINDINGS_KIND}', '${EVIDENCE_FINDINGS_KIND}', '${MAIL_FINDINGS_KIND}') ` +
  "AND json_array_length(p.result, '$.accepted') = 0 THEN 'rejected' ELSE p.status END"
const NAMED =
  `SELECT p.*, ${STATUS} AS shown_status, b.name AS proposer_name, b.kind AS proposer_kind FROM proposed_actions p ` +
  "LEFT JOIN bots b ON p.proposed_by_type = 'bot' AND b.id = p.proposed_by_id"

type ProposalOperations = Omit<
  {
    [K in keyof ProposedActionsStore]: ProposedActionsStore[K] extends (...args: infer A) => Promise<infer R>
      ? (...args: A) => R
      : never
  },
  "approve" | "reject"
> & {
  /** Records a decision already checked; `by` records an agent deciding for the owner. */
  approve(id: string, result?: unknown, by?: Author): ProposedAction
  reject(id: string, by?: Author, result?: unknown): ProposedAction
  /** Who proposed it, for `mayDecide`. */
  proposer(id: string): Proposer
}

/** Who proposed an action, for `mayDecide`. */
export const proposerOfAction = ({ proposedBy, payload }: ProposedAction): Proposer =>
  proposedBy.type === "person"
    ? { type: "person", id: proposedBy.id }
    : proposedBy.name === null
      ? { type: "unknown" }
      : {
          type: "bot",
          id: proposedBy.id,
          name: proposedBy.name,
          kind: proposedBy.kind ?? "agent",
          ...(movedSuggestion(payload) ? { verified: false as const } : {}),
        }

/** A suggestion moved from `links` names its bot only as the link's provenance text said it (store version 44). */
const movedSuggestion = (payload: unknown): boolean =>
  typeof payload === "object" && payload !== null && "suggestedLink" in payload

export const proposalOperationsOver = (context: StoreContext): ProposalOperations => {
  const { database, now } = context
  const actionOf = (row: Row): ProposedAction => {
    const account =
      row.account_id == null
        ? undefined
        : database.prepare("SELECT provider, external_id FROM accounts WHERE id = ?").get(Number(row.account_id))
    return {
      id: String(row.id),
      kind: String(row.kind),
      account: account ? { provider: String(account.provider), account: String(account.external_id) } : null,
      target:
        row.target_type == null
          ? null
          : (referenceOfThing(database, storedThing(row.target_type, row.target_id)) ?? null),
      payload: json(row.payload),
      reason: row.reason == null ? null : String(row.reason),
      status: row.shown_status as ProposedAction["status"],
      proposedBy: {
        type: row.proposed_by_type as Actor["type"],
        id: String(row.proposed_by_id),
        name: row.proposer_name == null ? null : String(row.proposer_name),
        kind:
          row.proposed_by_type !== "bot"
            ? null
            : row.proposer_kind === "rule" || row.proposer_name === "rule"
              ? "rule"
              : "agent",
      },
      decidedBy:
        row.decided_by_type == null
          ? null
          : { type: row.decided_by_type as Actor["type"], id: String(row.decided_by_id) },
      decidedAt: iso(row.decided_at),
      executedAt: iso(row.executed_at),
      result: json(row.result),
      error: row.error == null ? null : String(row.error),
      verdict: (row.verdict ?? null) as ProposedAction["verdict"],
      createdAt: iso(row.created_at) as string,
    }
  }
  const rowOf = (id: string): Row => {
    const row = /^\d+$/.test(id) ? database.prepare(`${NAMED} WHERE p.id = ?`).get(Number(id)) : undefined
    if (!row) throw new CliError("not_found", `no proposed action ${id}`)
    return row
  }
  /** Moves an action from one of `from` to `to`, or says why it cannot. */
  const move = (
    id: string,
    from: ProposedAction["status"][],
    to: ProposedAction["status"],
    set = "",
    values: unknown[] = [],
  ) =>
    write(database, () => {
      const row = rowOf(id)
      if (!from.includes(row.status as ProposedAction["status"]))
        throw new CliError("validation_error", `a ${String(row.status)} action cannot become ${to}`, {
          reason: "proposal.wrong-state",
        })
      database
        .prepare(`UPDATE proposed_actions SET status = ?, updated_at = ?${set} WHERE id = ?`)
        .run(to, now(), ...(values as (string | number | null)[]), Number(id))
      return actionOf(rowOf(id))
    })
  const decide = (id: string, to: "approved" | "rejected", result?: unknown, by: Author = "owner") => {
    const { actor } = authorActor(context, by)
    return move(id, ["proposed"], to, ", decided_by_type = ?, decided_by_id = ?, decided_at = ?, result = ?", [
      actor.type,
      actor.id,
      now(),
      result === undefined ? null : JSON.stringify(result),
    ])
  }

  return {
    propose: ({ kind, by, account, target, payload, reason }) => {
      if (!/^[a-z][a-z_]{0,39}$/.test(kind))
        throw new CliError("validation_error", "an action's kind is a lower-case word, e.g. reply, ban, create_task")
      if (reason !== undefined && reason.length > 2000)
        throw new CliError("validation_error", "a reason takes up to 2000 characters")
      const encoded = payload === undefined ? null : JSON.stringify(payload)
      if (encoded !== null && encoded.length > 100_000)
        throw new CliError("validation_error", "a payload takes up to 100000 characters")
      const id = write(database, () => {
        const accountId =
          account === undefined
            ? null
            : database
                .prepare("SELECT id FROM accounts WHERE provider = ? AND external_id = ?")
                .get(account.provider, account.account)?.id
        if (account !== undefined && accountId == null)
          throw new CliError("not_found", "the account is not in the local store")
        const thing = target === undefined ? undefined : requiredThing(database, target)
        const { actor } = authorActor(context, by)
        const at = now()
        return Number(
          database
            .prepare(
              "INSERT INTO proposed_actions (kind, account_id, target_type, target_id, payload, reason, status, proposed_by_type, " +
                "proposed_by_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?) RETURNING id",
            )
            .get(
              kind,
              (accountId as number | null) ?? null,
              thing?.type ?? null,
              thing?.id ?? null,
              encoded,
              reason?.trim() || null,
              actor.type,
              actor.id,
              at,
              at,
            )?.id,
        )
      })
      return actionOf(rowOf(String(id)))
    },
    get: (id) => actionOf(rowOf(id)),
    pending: ({ limit = 100 } = {}) =>
      database
        .prepare(`${NAMED} WHERE p.status = 'proposed' ORDER BY p.created_at, p.id LIMIT ?`)
        .all(Math.min(Math.max(limit, 1), 500))
        .map(actionOf),
    list: ({ status, limit = 100, kinds, except, proposedBy, project } = {}) => {
      if (status !== undefined && !PROPOSAL_STATUSES.includes(status))
        throw new CliError("validation_error", `a status is one of ${PROPOSAL_STATUSES.join(", ")}`)
      const by = proposedBySql("p.proposed_by_type", "p.proposed_by_id", proposedBy)
      return database
        .prepare(
          `${NAMED} WHERE (? IS NULL OR ${STATUS} = ?) AND (? IS NULL OR p.kind IN (SELECT value FROM json_each(?))) ` +
            "AND p.kind NOT IN (SELECT value FROM json_each(?)) AND (? IS NULL OR (p.target_type = 'project' AND " +
            "'project:' || p.target_id = ?) OR json_extract(p.payload, '$.to') = ? OR json_extract(p.payload, '$.from') = ? " +
            `OR json_extract(p.payload, '$.project') = ?) AND ${by.sql} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
        )
        .all(
          status ?? null,
          status ?? null,
          kinds === undefined ? null : 1,
          JSON.stringify(kinds ?? []),
          JSON.stringify(except ?? []),
          ...Array(5).fill(project ?? null),
          ...by.params,
          Math.min(Math.max(limit, 1), 500),
        )
        .map(actionOf)
    },
    approve: (id, result, by) => decide(id, "approved", result, by),
    reject: (id, by, result) => decide(id, "rejected", result, by),
    proposer: (id) => proposerOfAction(actionOf(rowOf(id))),
    executed: (id, result) =>
      move(id, ["approved"], "executed", ", executed_at = ?, result = ?", [
        now(),
        result === undefined ? null : JSON.stringify(result),
      ]),
    failed: (id, error) =>
      move(id, ["approved"], "failed", ", executed_at = ?, error = ?", [
        now(),
        error.trim().slice(0, 2000) || "failed",
      ]),
    judge: (id, verdict) => {
      if (verdict !== null && !PROPOSAL_VERDICTS.includes(verdict))
        throw new CliError("validation_error", `a verdict is one of ${PROPOSAL_VERDICTS.join(", ")}`)
      rowOf(id)
      database
        .prepare("UPDATE proposed_actions SET verdict = ?, updated_at = ? WHERE id = ?")
        .run(verdict, now(), Number(id))
      return actionOf(rowOf(id))
    },
  }
}

const FINDINGS_COMMAND = "the dedicated findings command"

/** Stored kinds a generic action path never decides: each has its own review, which checks what it cites. */
const DEDICATED_REVIEW: Record<string, { what: string; reason: string; through: string }> = {
  [MEETING_FINDINGS_KIND]: {
    what: "meeting findings",
    reason: "meeting-findings.dedicated-review",
    through: FINDINGS_COMMAND,
  },
  [EVIDENCE_FINDINGS_KIND]: {
    what: "evidence findings",
    reason: "evidence-findings.dedicated-review",
    through: FINDINGS_COMMAND,
  },
  [MAIL_FINDINGS_KIND]: { what: "mail findings", reason: "mail-findings.dedicated-review", through: FINDINGS_COMMAND },
  [SOURCE_REVIEW_KIND]: {
    what: "a source review",
    reason: "source-review.dedicated-review",
    through: "the review of memories and facts, which signs their sources again",
  },
}

/** Refuses a dedicated kind on a generic action path: approving one as an action would skip its own checks. */
export const assertGenericAction = (kind: string): void => {
  const dedicated = DEDICATED_REVIEW[kind]
  if (dedicated)
    throw new CliError("validation_error", `review ${dedicated.what} through ${dedicated.through}`, {
      reason: dedicated.reason,
    })
}

export const proposedActionsStoreOver = (context: StoreContext): ProposedActionsStore => {
  const operations = proposalOperationsOver(context)
  const generic = (id: string) => {
    const { kind } = operations.get(id)
    assertGenericAction(kind)
    return kind
  }
  return {
    propose: async (input) => {
      const dedicated = DEDICATED_REVIEW[input.kind]
      if (dedicated)
        throw new CliError("validation_error", `stage ${dedicated.what} through ${dedicated.through}`, {
          reason: dedicated.reason,
        })
      return operations.propose(input)
    },
    get: async (id) => operations.get(id),
    pending: async (options) => operations.pending(options),
    list: async (options) => operations.list(options),
    approve: async (id, by, result) => {
      const kind = generic(id)
      assertMayDecide({ id, kind, proposedBy: operations.proposer(id) }, by, context.decisions)
      return operations.approve(id, result, deciderAuthor(by))
    },
    reject: async (id, by, reason) => {
      const kind = generic(id)
      assertMayDecide({ id, kind, proposedBy: operations.proposer(id) }, by, context.decisions)
      return operations.reject(id, deciderAuthor(by), reason?.trim() ? { reason: reason.trim() } : undefined)
    },
    executed: async (id, result) => {
      generic(id)
      return operations.executed(id, result)
    },
    failed: async (id, error) => {
      generic(id)
      return operations.failed(id, error)
    },
    judge: async (id, verdict) => operations.judge(id, verdict),
  }
}
