import { CliError } from "@wirecat/cli-base"
import { DECIDED_TABLES, type DecidedTable, type DecidedType } from "../../domain/record-types.js"
import { assertMayDecide, botKey, type Decider, deciderAuthor } from "../decisions.js"
import { proposerOf } from "./actors.js"
import { type Author, authorActor } from "./memories.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"

type Row = Record<string, unknown>

export interface Decision {
  by: Decider
  reason?: string
  confirm: boolean
}

/** A reviewed row the owner decides; its `author_name` comes from the bots join every reviewed query makes. */
export const decisionsOver = (context: StoreContext) => {
  const { database, now } = context

  const keepDecision = (table: DecidedTable, id: number, by: Decider, reason?: string) => {
    const why = [by === "owner" ? undefined : by.reason.trim(), reason?.trim() || undefined].filter(Boolean).join(": ")
    if (by === "owner" && !why) return
    const decision = by === "owner" ? { by: "owner", reason: why } : { by: "agent", bot: by.bot, reason: why }
    database
      .prepare(`UPDATE ${table} SET metadata = json_set(coalesce(metadata, '{}'), '$.decision', json(?)) WHERE id = ?`)
      .run(JSON.stringify(decision), id)
  }

  /**
   * Confirms or rejects a proposed row; only the owner decides money. `before` runs the checks that may still refuse
   * and `after` what follows from the decision, both in its transaction.
   */
  const decideRow = (
    type: DecidedType,
    row: Row,
    { by, reason, confirm }: Decision,
    within: { before?: () => void; after?: () => void } = {},
  ) => {
    const ref = `${type}:${row.id}`
    assertMayDecide(
      { id: ref, proposedBy: proposerOf(database, row.author_type, row.author_id), ownerOnly: true },
      by,
      context.decisions,
    )
    if (row.review !== "proposed")
      throw new CliError("validation_error", `${ref} is already ${String(row.review)}`, {
        reason: "proposal.wrong-state",
      })
    const table = DECIDED_TABLES[type]
    const id = Number(row.id)
    write(database, () => {
      within.before?.()
      const at = now()
      if (confirm) {
        const { actor } = authorActor(context, deciderAuthor(by))
        database
          .prepare(
            `UPDATE ${table} SET review = 'confirmed', confirmed_by_type = ?, confirmed_by_id = ?, updated_at = ? WHERE id = ?`,
          )
          .run(actor.type, actor.id, at, id)
      } else database.prepare(`UPDATE ${table} SET review = 'rejected', updated_at = ? WHERE id = ?`).run(at, id)
      keepDecision(table, id, by, reason)
      within.after?.()
    })
  }

  /**
   * Lines, allocations and splits: the owner changes any; a bot only those of a row it proposed that is still
   * proposed, as its own draft.
   */
  const mayChangeParts = (row: Row, by: Author, message: string) => {
    if (by === "owner") return
    const own =
      row.author_type === "bot" && row.author_name != null && botKey(String(row.author_name)) === botKey(by.bot)
    if (row.review !== "proposed" || !own)
      throw new CliError("permission_error", message, { reason: "finance.owner-only" })
  }

  return { keepDecision, decideRow, mayChangeParts }
}
