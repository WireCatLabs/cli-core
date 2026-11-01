import { CliError } from "@wirecat/cli-base"
import { isClosedState } from "../../tasks/index.js"
import { type Author, authorActor } from "./memories.js"
import type { StoreContext } from "./open.js"
import {
  type AgentCloseSettings,
  CLEAR_SUGGESTION,
  type CloseSuggestion,
  certaintyOf,
  closeSuggestionOf,
  saveAgentClose,
  storeAgentClose,
} from "./task-close.js"
import { DEFAULT_FIRST_PASS_PER_CHAT, savedFirstPassPerChat, saveFirstPassPerChat } from "./task-first-pass.js"
import { taskRowOf } from "./things.js"
import { write } from "./transaction.js"
import { recordTaskEvent } from "./work-tasks.js"

export interface TaskCloseStore {
  agentClose(): Promise<AgentCloseSettings>
  saveAgentClose(change: { allowed?: boolean | null; min?: number | null }): Promise<void>
  /** How many tasks the first rule pass after a sync may open per chat. */
  firstPassPerChat(): Promise<number>
  saveFirstPassPerChat(value: number | null): Promise<void>
  closeSuggestion(id: string): Promise<CloseSuggestion | null>
  /**
   * Marks an open task with the close an agent would make, replacing an earlier one, and releases its claim so the
   * owner's agenda lists it. `null` clears it: the owner rejected it.
   */
  suggestClose(
    id: string,
    suggestion: { as: CloseSuggestion["as"]; certainty: number; reason?: string } | null,
    by: Author,
  ): Promise<void>
  /** How sure the agent that closed the task said it was. */
  recordCloseCertainty(id: string, certainty: number): Promise<void>
}

export const taskCloseOver = (context: StoreContext): TaskCloseStore => {
  const { database, now } = context
  const liveRow = (id: string) => {
    const row = taskRowOf(database, id)
    const found =
      row === undefined
        ? undefined
        : database.prepare("SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL").get(row)
    if (!found) throw new CliError("not_found", `no task ${id}`)
    return found
  }
  return {
    agentClose: async () => storeAgentClose(database),
    saveAgentClose: async (change) => write(database, () => saveAgentClose(database, change, now())),
    firstPassPerChat: async () => savedFirstPassPerChat(database) ?? DEFAULT_FIRST_PASS_PER_CHAT,
    saveFirstPassPerChat: async (value) => write(database, () => saveFirstPassPerChat(database, value, now())),
    closeSuggestion: async (id) => closeSuggestionOf(database, liveRow(id)),
    suggestClose: async (id, suggestion, by) =>
      write(database, () => {
        const row = liveRow(id)
        if (isClosedState(String(row.status)))
          throw new CliError("validation_error", `task ${String(row.key)} is already ${String(row.status)}`, {
            reason: "task.closed",
          })
        const before = closeSuggestionOf(database, row)
        const { actor } = authorActor(context, by)
        const at = now()
        if (suggestion === null) {
          if (before === null)
            throw new CliError("validation_error", `task ${String(row.key)} has no close waiting on the owner`, {
              reason: "task.no-close-suggestion",
            })
          database.prepare(`UPDATE tasks SET ${CLEAR_SUGGESTION}, updated_at = ? WHERE id = ?`).run(at, Number(row.id))
          recordTaskEvent(database, Number(row.id), actor, "close-suggestion", { suggestion: [before, null] }, at)
          return
        }
        const reason = suggestion.reason?.trim() || null
        database
          .prepare(
            "UPDATE tasks SET close_suggested_as = ?, close_suggested_by_type = ?, close_suggested_by_id = ?, " +
              "close_suggested_certainty = ?, close_suggested_reason = ?, close_suggested_at = ?, " +
              "claimed_by = NULL, claimed_until = NULL, updated_at = ? WHERE id = ?",
          )
          .run(suggestion.as, actor.type, actor.id, certaintyOf(suggestion.certainty), reason, at, at, Number(row.id))
        const after = closeSuggestionOf(
          database,
          database.prepare("SELECT * FROM tasks WHERE id = ?").get(Number(row.id)) ?? {},
        )
        recordTaskEvent(database, Number(row.id), actor, "close-suggestion", { suggestion: [before, after] }, at)
      }),
    recordCloseCertainty: async (id, certainty) =>
      write(database, () => {
        const row = liveRow(id)
        const value = certaintyOf(certainty)
        database.prepare("UPDATE tasks SET close_certainty = ? WHERE id = ?").run(value, Number(row.id))
        if ((row.close_certainty ?? null) !== value)
          recordTaskEvent(
            database,
            Number(row.id),
            null,
            "close-certainty",
            { close_certainty: [row.close_certainty ?? null, value] },
            now(),
          )
      }),
  }
}
