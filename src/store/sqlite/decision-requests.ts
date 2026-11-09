import { createHash, randomBytes } from "node:crypto"
import { CliError } from "@wirecat/cli-base"
import { DECISION_ACTIONS, DECISION_TTL_MS, type DecisionAction, isDecisionToken } from "../decision-requests.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"

/** The message a set of buttons is on. */
export interface DecisionMessage {
  channel: string
  botProfile: string
  chatId: string
  messageId: string
}

export interface DecisionRequestInput extends DecisionMessage {
  proposalId: string
  batchDigest: string
  ownerUserId: string
  /** One button each, in this order; no action twice. */
  actions: readonly DecisionAction[]
}

export interface DecisionRequest extends DecisionMessage {
  proposalId: string
  action: DecisionAction
  batchDigest: string
  ownerUserId: string
  createdAt: number
  expiresAt: number
}

/** Where and by whom the press came; every part must equal what the button was sent with. */
export interface DecisionPress {
  botProfile: string
  chatId: string
  messageId: string
  ownerUserId: string
}

export type DecisionRefusal =
  | "decision.token-unknown"
  | "decision.token-used"
  | "decision.token-cancelled"
  | "decision.token-expired"
  | "decision.token-mismatch"

export type TakeResult =
  | { ok: true; request: DecisionRequest; cancelled: number }
  | { ok: false; reason: DecisionRefusal }

export interface DecisionRequestStore {
  /** One token per action, for one message; the tokens are returned once and kept only as digests. */
  create(input: DecisionRequestInput): { action: DecisionAction; token: string }[]
  /**
   * Uses a token once and cancels the message's other open tokens in the same transaction. A token for another
   * bot, chat, message or owner is refused as a mismatch before its state is looked at, and stays open.
   */
  take(token: string, expect: DecisionPress): TakeResult
  /** Cancels every open token, of one bot when given; for turning the feature off. Returns how many. */
  cancelOpen(scope?: Partial<Pick<DecisionMessage, "channel" | "botProfile">>): number
  /** Deletes rows that expired, were used or were cancelled more than 30 days before `at`; returns how many. */
  prune(at?: number): number
  /** The open (unused, uncancelled, unexpired) buttons of a message, oldest first. */
  open(message: DecisionMessage): DecisionRequest[]
}

const digestOf = (token: string) => createHash("sha256").update(token).digest("hex")
const newToken = () => randomBytes(16).toString("base64url")

interface Row {
  id: number
  proposal_id: string
  action: DecisionAction
  batch_digest: string
  channel: string
  bot_profile: string
  chat_id: string
  message_id: string
  owner_user_id: string
  created_at: number
  expires_at: number
  used_at: number | null
  cancelled_at: number | null
}

const requestOf = (row: Row): DecisionRequest => ({
  proposalId: row.proposal_id,
  action: row.action,
  batchDigest: row.batch_digest,
  channel: row.channel,
  botProfile: row.bot_profile,
  chatId: row.chat_id,
  messageId: row.message_id,
  ownerUserId: row.owner_user_id,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
})

const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000
const SAME_MESSAGE = "channel=? AND bot_profile=? AND chat_id=? AND message_id=?"
const OPEN = "used_at IS NULL AND cancelled_at IS NULL"

export const decisionRequestStoreOver = ({ database, now }: StoreContext): DecisionRequestStore => {
  const refusal = (row: Row | undefined, at: number): DecisionRefusal | undefined => {
    if (!row) return "decision.token-unknown"
    if (row.used_at !== null) return "decision.token-used"
    if (row.cancelled_at !== null) return "decision.token-cancelled"
    if (row.expires_at <= at) return "decision.token-expired"
    return undefined
  }

  return {
    create: (input) => {
      const { actions, ...fields } = input
      const text = [
        fields.proposalId,
        fields.batchDigest,
        fields.channel,
        fields.botProfile,
        fields.chatId,
        fields.messageId,
        fields.ownerUserId,
      ]
      if (text.some((value) => typeof value !== "string" || value === ""))
        throw new CliError("validation_error", "a decision request needs its batch, message and owner", {
          reason: "decision.request-invalid",
        })
      if (
        actions.length === 0 ||
        new Set(actions).size !== actions.length ||
        actions.some((action) => !DECISION_ACTIONS.includes(action))
      )
        throw new CliError("validation_error", "a decision request needs distinct, known actions", {
          reason: "decision.request-invalid",
        })
      const at = now()
      return write(database, () =>
        actions.map((action) => {
          const token = newToken()
          database
            .prepare(
              `INSERT INTO decision_requests (token_digest, proposal_id, action, batch_digest, channel, bot_profile,
                chat_id, message_id, owner_user_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              digestOf(token),
              fields.proposalId,
              action,
              fields.batchDigest,
              fields.channel,
              fields.botProfile,
              fields.chatId,
              fields.messageId,
              fields.ownerUserId,
              at,
              at + DECISION_TTL_MS,
            )
          return { action, token }
        }),
      )
    },

    take: (token, expect) => {
      if (!isDecisionToken(token)) return { ok: false, reason: "decision.token-unknown" }
      const digest = digestOf(token)
      return write(database, (): TakeResult => {
        const at = now()
        const row = database.prepare("SELECT * FROM decision_requests WHERE token_digest=?").get(digest) as
          | Row
          | undefined
        if (!row) return { ok: false, reason: "decision.token-unknown" }
        if (
          expect.botProfile !== row.bot_profile ||
          expect.chatId !== row.chat_id ||
          expect.messageId !== row.message_id ||
          expect.ownerUserId !== row.owner_user_id
        )
          return { ok: false, reason: "decision.token-mismatch" }
        const reason = refusal(row, at)
        if (reason) return { ok: false, reason }
        database.prepare("UPDATE decision_requests SET used_at=? WHERE id=?").run(at, row.id)
        const { changes } = database
          .prepare(`UPDATE decision_requests SET cancelled_at=? WHERE ${SAME_MESSAGE} AND id<>? AND ${OPEN}`)
          .run(at, row.channel, row.bot_profile, row.chat_id, row.message_id, row.id)
        return { ok: true, request: requestOf(row), cancelled: Number(changes) }
      })
    },

    cancelOpen: (scope = {}) => {
      const filters: string[] = []
      const values: string[] = []
      if (scope.channel !== undefined) {
        filters.push("channel=?")
        values.push(scope.channel)
      }
      if (scope.botProfile !== undefined) {
        filters.push("bot_profile=?")
        values.push(scope.botProfile)
      }
      const where = [OPEN, ...filters].join(" AND ")
      return write(database, () =>
        Number(
          database.prepare(`UPDATE decision_requests SET cancelled_at=? WHERE ${where}`).run(now(), ...values).changes,
        ),
      )
    },

    prune: (at = now()) => {
      const cutoff = at - PRUNE_AFTER_MS
      // One `?` per use: Node 22.16's node:sqlite cannot bind a numbered `?1` by position.
      return write(database, () =>
        Number(
          database
            .prepare(`DELETE FROM decision_requests WHERE expires_at < ? OR used_at < ? OR cancelled_at < ?`)
            .run(cutoff, cutoff, cutoff).changes,
        ),
      )
    },

    open: (message) =>
      (
        database
          .prepare(`SELECT * FROM decision_requests WHERE ${SAME_MESSAGE} AND ${OPEN} AND expires_at>? ORDER BY id`)
          .all(message.channel, message.botProfile, message.chatId, message.messageId, now()) as unknown as Row[]
      ).map(requestOf),
  }
}
