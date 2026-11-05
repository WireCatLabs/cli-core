import { CliError } from "@wirecat/cli-base"
import { deciderAuthor, TASK_CLOSE_KIND } from "../../../store/decisions.js"
import type { MessageStore, TaskDetails } from "../../../store/index.js"
import { createTaskService } from "../../../tasks/index.js"
import type { Decided, ProposalKind, ProposalRow } from "../types.js"
import { kept } from "./shared.js"

const rowOf = (task: TaskDetails): ProposalRow | undefined => {
  const suggestion = task.closeSuggestion
  if (suggestion === null) return undefined
  return {
    id: `close:${task.key}`,
    kind: TASK_CLOSE_KIND,
    status: "proposed",
    project: task.project,
    subject: task.ref,
    object: null,
    summary: `close as ${suggestion.as}: ${task.title}`,
    proposedBy: { type: "bot", id: suggestion.by, name: suggestion.by, kind: "agent" },
    reason: suggestion.reason,
    evidence: task.source === null ? [] : [task.source],
    score: suggestion.certainty,
    signals: null,
    parts: null,
    createdAt: suggestion.at,
  }
}

/**
 * An agent's close of an open task, waiting on the owner (`close_suggested_*`). Confirming closes it as suggested;
 * rejecting clears the suggestion, as `tasks reject` does. Its id is `close:<task key>`; only the owner decides it.
 */
export const taskCloseKind = (store: Pick<MessageStore, "tasks">): ProposalKind => {
  const taskOf = async (id: string) => {
    const key = id.slice("close:".length)
    const task = await store.tasks.details(key).catch(() => undefined)
    const row = task && rowOf(task)
    if (!task || !row) throw new CliError("not_found", `no close waits on task ${key}`)
    return { task, row }
  }
  return {
    kind: TASK_CLOSE_KIND,
    prefix: "close",
    ownerOnly: true,
    list: async (filter) => {
      if ((filter.status ?? "proposed") !== "proposed" && filter.status !== "all") return []
      const tasks = await store.tasks.find({
        status: "open",
        where: { sql: "t.close_suggested_as IS NOT NULL", params: [] },
        limit: filter.offset + filter.limit,
      })
      return kept(
        tasks.flatMap((task) => rowOf(task) ?? []),
        { ...filter, limit: filter.offset + filter.limit },
      )
    },
    get: async (id) => (await taskOf(id)).row,
    decide: async (id, { confirm, by, reason }): Promise<Decided> => {
      const { task } = await taskOf(id)
      const suggestion = task.closeSuggestion
      if (!confirm || suggestion === null) {
        await store.tasks.suggestClose(task.id, null, "owner")
        return { id, kind: TASK_CLOSE_KIND, status: "rejected", made: [] }
      }
      // A project task has no row in the message task service; a message task closes there, keeping the
      // suggestion's reason as `tasks close` does.
      if ((await store.tasks.get(task.id)) === undefined)
        await store.tasks.edit(
          task.id,
          { status: suggestion.as, ...(reason === undefined ? {} : { reason }) },
          deciderAuthor(by),
        )
      else {
        const why = reason ?? suggestion.reason ?? undefined
        await createTaskService({ store: store.tasks }).close(task.id, {
          as: suggestion.as,
          by: "owner",
          ...(why === undefined ? {} : { reason: why }),
        })
      }
      return { id, kind: TASK_CLOSE_KIND, status: "confirmed", made: [task.ref] }
    },
  }
}
