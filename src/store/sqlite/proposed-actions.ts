import { CliError } from "@wirecat/cli-base"
import { MEETING_FINDINGS_KIND } from "../../meetings/index.js"
import { EVIDENCE_FINDINGS_KIND } from "../evidence-findings.js"
import type { AccountKey } from "../types.js"
import type { Actor } from "./actors.js"
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
  /** `name` is a bot's handle; `null` for a person. */
  proposedBy: { type: Actor["type"]; id: string; name: string | null }
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
  /** Newest first; every status unless one is named. */
  list(options?: { status?: ProposedAction["status"]; limit?: number }): Promise<ProposedAction[]>
  /** `result` records what the approval made, such as the task it became. */
  approve(id: string, result?: unknown): Promise<ProposedAction>
  reject(id: string): Promise<ProposedAction>
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
  `CASE WHEN p.status = 'approved' AND p.kind IN ('${MEETING_FINDINGS_KIND}', '${EVIDENCE_FINDINGS_KIND}') ` +
  "AND json_array_length(p.result, '$.accepted') = 0 THEN 'rejected' ELSE p.status END"
const NAMED =
  `SELECT p.*, ${STATUS} AS shown_status, b.name AS proposer_name FROM proposed_actions p ` +
  "LEFT JOIN bots b ON p.proposed_by_type = 'bot' AND b.id = p.proposed_by_id"

type ProposalOperations = Omit<
  {
    [K in keyof ProposedActionsStore]: ProposedActionsStore[K] extends (...args: infer A) => Promise<infer R>
      ? (...args: A) => R
      : never
  },
  "approve"
> & {
  /** `by` records an agent deciding for the owner; the public store always records the owner. */
  approve(id: string, result?: unknown, by?: Author): ProposedAction
}

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
    list: ({ status, limit = 100 } = {}) => {
      if (status !== undefined && !PROPOSAL_STATUSES.includes(status))
        throw new CliError("validation_error", `a status is one of ${PROPOSAL_STATUSES.join(", ")}`)
      return database
        .prepare(`${NAMED} WHERE (? IS NULL OR ${STATUS} = ?) ORDER BY p.created_at DESC, p.id DESC LIMIT ?`)
        .all(status ?? null, status ?? null, Math.min(Math.max(limit, 1), 500))
        .map(actionOf)
    },
    approve: (id, result, by) => decide(id, "approved", result, by),
    reject: (id) => decide(id, "rejected"),
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

export const proposedActionsStoreOver = (context: StoreContext): ProposedActionsStore => {
  const operations = proposalOperationsOver(context)
  const generic = (id: string) => {
    const kind = operations.get(id).kind
    if (kind === MEETING_FINDINGS_KIND)
      throw new CliError("validation_error", "review meeting findings through the dedicated findings command", {
        reason: "meeting-findings.dedicated-review",
      })
    if (kind === EVIDENCE_FINDINGS_KIND)
      throw new CliError("validation_error", "review evidence findings through the dedicated findings command", {
        reason: "evidence-findings.dedicated-review",
      })
  }
  return {
    propose: async (input) => {
      if (input.kind === MEETING_FINDINGS_KIND)
        throw new CliError("validation_error", "stage meeting findings through the dedicated findings command")
      if (input.kind === EVIDENCE_FINDINGS_KIND)
        throw new CliError("validation_error", "stage evidence findings through the dedicated findings command")
      return operations.propose(input)
    },
    get: async (id) => operations.get(id),
    pending: async (options) => operations.pending(options),
    list: async (options) => operations.list(options),
    approve: async (id, result) => {
      generic(id)
      return operations.approve(id, result)
    },
    reject: async (id) => {
      generic(id)
      return operations.reject(id)
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
