import { type Payment, validatePayment } from "../../meetings/index.js"
import { type Author, dropLinksOf, evidenceOf, keepHighestId } from "./memories.js"
import type { StoreContext } from "./open.js"
import { type PaymentOutcome, paymentEntriesOver } from "./payment-entries.js"
import { write } from "./transaction.js"

/** Set by store version 46 and deleted once the move ran. */
export const PAYMENT_FACTS_TO_MOVE = "payment_facts_to_move"

type Row = Record<string, unknown>

const paymentOf = (metadata: unknown): Payment | undefined => {
  try {
    return validatePayment((JSON.parse(String(metadata)) as { payment?: unknown }).payment)
  } catch {
    return undefined
  }
}

/**
 * Moves the payment facts store versions 44–45 took into `store.finance`, as a payment finding is recorded now: a
 * paid one a payment, an expected one an invoice, a cancelled one voids the invoice it supersedes. An accepted fact
 * becomes a confirmed row and a proposed one stays proposed; a rejected one, or one a correction superseded, is
 * rejected. An expected fact that a payment or a cancellation superseded held until then, so its invoice is
 * confirmed and the payment settles it. What cannot be a row (no party for an invoice, a pending cancellation, an
 * owner's fact that no longer holds) stays a `statement` fact with the fields under `metadata.retired_payment`.
 */
export const movePaymentFacts = (context: StoreContext): number => {
  const { database, now } = context
  if (!database.prepare("SELECT 1 AS found FROM store_settings WHERE key = ?").get(PAYMENT_FACTS_TO_MOVE)) return 0
  const record = paymentEntriesOver(context)
  return write(database, () => {
    const rows = database
      .prepare(
        "SELECT f.*, b.name AS bot_name, b.kind AS bot_kind FROM facts f " +
          "LEFT JOIN bots b ON f.author_type = 'bot' AND b.id = f.author_id WHERE f.type = 'payment' ORDER BY f.id",
      )
      .all()
    const nextState = (id: number) =>
      paymentOf(
        database
          .prepare("SELECT metadata FROM facts WHERE supersedes_id = ? AND type = 'payment' ORDER BY id DESC LIMIT 1")
          .get(id)?.metadata,
      )?.state
    const outcomeOf = (row: Row, payment: Payment): PaymentOutcome => {
      if (row.status === "proposed") return "proposed"
      if (row.status === "accepted") return { confirm: true, by: "owner" }
      const settled = row.status === "superseded" && payment.state === "expected" && nextState(Number(row.id))
      return { confirm: settled === "paid" || settled === "cancelled", by: "owner" }
    }
    const moved = new Map<number, string>()
    for (const row of rows) {
      const id = Number(row.id)
      const payment = paymentOf(row.metadata)
      if (!payment) continue
      const by: Author =
        row.author_type === "bot" && row.bot_name != null
          ? {
              bot: String(row.bot_name),
              kind: row.bot_kind === "rule" ? "rule" : "agent",
              ...(row.model == null ? {} : { model: String(row.model) }),
            }
          : "owner"
      const outcome = outcomeOf(row, payment)
      const holds = outcome !== "proposed" && outcome.confirm
      if ((by === "owner" && !holds) || (payment.state === "cancelled" && !holds)) continue
      const target = row.supersedes_id == null ? undefined : moved.get(Number(row.supersedes_id))
      const entry = {
        payment,
        statement: String(row.statement),
        ...(row.project_id == null ? {} : { project: `project:${row.project_id}` }),
        evidence: evidenceOf(context, { type: "fact", id }),
        ...(payment.state !== "expected" && target?.startsWith("invoice:") ? { supersedes: target } : {}),
      }
      try {
        moved.set(
          id,
          write(database, () => record(entry, by, by === "owner" ? "proposed" : outcome)),
        )
      } catch {
        // Kept below as a statement: an unknown currency or a party that is gone is no reason to lose the fact.
      }
    }
    if (moved.size) keepHighestId(database, "facts", now())
    for (const id of moved.keys()) {
      database.prepare("UPDATE facts SET supersedes_id = NULL WHERE supersedes_id = ?").run(id)
      dropLinksOf(database, { type: "fact", id })
      database.prepare("DELETE FROM links WHERE from_type = 'fact' AND from_id = ?").run(id)
      database.prepare("DELETE FROM taggings WHERE taggable_type = 'fact' AND taggable_id = ?").run(id)
      database.prepare("DELETE FROM facts WHERE id = ?").run(id)
    }
    database
      .prepare(
        "UPDATE facts SET type = 'statement', updated_at = ?, metadata = json_remove(json_set(coalesce(metadata, '{}'), " +
          "'$.retired_payment', json(json_extract(metadata, '$.payment'))), '$.payment') WHERE type = 'payment'",
      )
      .run(now())
    database.prepare("DELETE FROM store_settings WHERE key = ?").run(PAYMENT_FACTS_TO_MOVE)
    return moved.size
  })
}
