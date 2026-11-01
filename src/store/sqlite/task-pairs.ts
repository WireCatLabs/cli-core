import { CliError } from "@wirecat/cli-base"
import type { Similarity } from "../../search/task-similarity.js"
import { isClosedState } from "../../tasks/index.js"
import { folded } from "./folded.js"
import { linkKind } from "./link-kinds.js"
import { type Author, authorActor } from "./memories.js"
import { insertLink } from "./notes.js"
import type { StoreContext } from "./open.js"
import type { SimilarTask, TaskSimilarity } from "./task-candidates.js"
import { CLEAR_SUGGESTION } from "./task-close.js"
import { inboxKey } from "./task-keys.js"
import { validateTaskRelation } from "./task-relations.js"
import { taskIdOf, taskRowOf, thingOf } from "./things.js"
import { read, write } from "./transaction.js"
import { recordTaskEvent } from "./work-tasks.js"

/**
 * What became of a pair: `review` waits for the agent that reviews after a sync, `unsure` for the owner; the rest
 * are labelled pairs (tasks update, "Learn from answers") — `merged`, `attached` say one job, `rejected`, `unmerged`,
 * `new` say two.
 */
export const TASK_PAIR_DECISIONS = ["review", "unsure", "merged", "rejected", "unmerged", "attached", "new"] as const
export type TaskPairDecision = (typeof TASK_PAIR_DECISIONS)[number]

export interface TaskPairSide {
  ref: string
  key: string
  title: string
  status: string
}

export interface TaskPair {
  /** The newer task, the would-be duplicate; null when an `--into` made none. */
  task: TaskPairSide | null
  /** The message an `--into` linked instead of opening a task. */
  source: string | null
  other: TaskPairSide
  score: number
  band: Similarity["band"]
  levels: Similarity["levels"]
  reasons: string[]
  decision: TaskPairDecision
  decidedAt: string | null
  createdAt: string
}

export interface TaskPairs {
  /**
   * After a rule opened `task`, or a message was linked to it (`linked`): every open or recent task in the likely or
   * maybe band goes to the review list, unless that pair was recorded before. A score cannot judge meaning, so it
   * never merges. A task just opened is instead a follow-up of the best recently closed one (`followUp`), which stays
   * off the list: a merge there would fold new work into a closed task. Returns how many went to the list.
   */
  reviewDuplicates(task: string, options?: { linked?: boolean }): Promise<number>
  /**
   * A new task about the same job as a task closed in the last 14 days is new work, never a reopening: links it
   * `follow-up-of` the best-scoring closed candidate and returns that task. A merged duplicate is skipped; the task it
   * was merged into is a candidate of its own.
   */
  followUp(task: string, candidates: readonly SimilarTask[], by: Author): Promise<TaskPairSide | undefined>
  /** The pairs of one account waiting at `decision`, newest first. */
  pairs(account: string, options: { decision: "review" | "unsure"; limit: number; offset: number }): Promise<TaskPair[]>
  /** A decision taken outside a merge — `attached`, `new` — with the comparison it was taken on. */
  recordPair(input: {
    task?: string
    source?: string
    other: string
    decision: "attached" | "new"
    similarity: Similarity
    by: Author
  }): Promise<void>
  /** `rejected` keeps the pair off the list for good; `unsure` passes it to the owner. */
  decidePair(task: string, other: string, decision: "rejected" | "unsure", by: Author): Promise<TaskPair>
  /**
   * Links every message of `dup` to `into`, closes `dup` dismissed with a `duplicate-of` relation, and records the
   * decision, in one write. Nothing is deleted.
   */
  merge(dup: string, into: string, by: Author): Promise<{ pair: TaskPair; linked: number }>
  /** Reopens a merged task and removes its `duplicate-of` relation; the links the merge added stay. */
  unmerge(dup: string, by: Author): Promise<{ pair: TaskPair }>
}

type Row = Record<string, unknown>

export const taskPairsOver = (context: StoreContext, similarity: TaskSimilarity): TaskPairs => {
  const { database, now } = context
  const required = (id: string): Row => {
    const row = taskRowOf(database, id.startsWith("task:") ? id.slice("task:".length) : id)
    const found =
      row === undefined
        ? undefined
        : database.prepare("SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL").get(row)
    if (!found) throw new CliError("not_found", `no task ${id}`)
    return found
  }
  const sideOf = (id: unknown): TaskPairSide | null => {
    if (id == null) return null
    const row = database.prepare("SELECT key, package_id, title, status FROM tasks WHERE id = ?").get(Number(id)) as Row
    return {
      ref: `task:${String(row.package_id ?? row.key)}`,
      key: String(row.key),
      title: String(row.title),
      status: String(row.status),
    }
  }
  const pairOf = (row: Row): TaskPair => ({
    task: sideOf(row.task_id),
    source: row.source_locator == null ? null : String(row.source_locator),
    other: sideOf(row.other_id) as TaskPairSide,
    score: Number(row.score),
    band: row.band as Similarity["band"],
    levels: JSON.parse(String(row.levels)),
    reasons: JSON.parse(String(row.reasons)),
    decision: row.decision as TaskPairDecision,
    decidedAt: row.decided_at == null ? null : new Date(Number(row.decided_at)).toISOString(),
    createdAt: new Date(Number(row.created_at)).toISOString(),
  })
  /** One pair, whichever way round it was recorded. */
  const heldPair = (a: number, b: number): Row | undefined =>
    database
      .prepare(
        "SELECT * FROM task_pairs WHERE (task_id = ? AND other_id = ?) OR (task_id = ? AND other_id = ?) ORDER BY id LIMIT 1",
      )
      .get(a, b, b, a)
  const insertPair = (
    pair: { task: number | null; source?: string; other: number; decision: TaskPairDecision },
    scored: Similarity,
    by: Author | null,
  ) => {
    const at = now()
    const actor = by === null ? null : authorActor(context, by).actor
    return Number(
      database
        .prepare(
          "INSERT INTO task_pairs (task_id, source_locator, other_id, score, band, levels, reasons, decision, " +
            "decided_by_type, decided_by_id, decided_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
            "RETURNING id",
        )
        .get(
          pair.task,
          pair.source ?? null,
          pair.other,
          scored.score,
          scored.band,
          JSON.stringify(scored.levels),
          JSON.stringify(scored.reasons),
          pair.decision,
          actor?.type ?? null,
          actor?.id ?? null,
          actor === null ? null : at,
          at,
          at,
        )?.id,
    )
  }
  const decide = (id: number, decision: TaskPairDecision, by: Author) => {
    const { actor } = authorActor(context, by)
    const at = now()
    database
      .prepare(
        "UPDATE task_pairs SET decision = ?, decided_by_type = ?, decided_by_id = ?, decided_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(decision, actor.type, actor.id, at, at, id)
  }
  const keepOwners = (held: Row, by: Author) => {
    if (by !== "owner" && held.decision !== "review" && held.decided_by_type === "person")
      throw new CliError(
        "permission_error",
        `the owner already decided this pair (${String(held.decision)}); an agent does not change it`,
        { reason: "task.pair-decided" },
      )
  }
  /** The pair's row, recorded now with a fresh comparison when it was never offered. */
  const settle = async (task: Row, other: Row, decision: TaskPairDecision, by: Author): Promise<TaskPair> => {
    const scored = heldPair(Number(task.id), Number(other.id))
      ? undefined
      : await similarity.compare({ task: String(task.key) }, String(other.key))
    return write(database, () => {
      const held = heldPair(Number(task.id), Number(other.id))
      const id = held
        ? Number(held.id)
        : insertPair({ task: Number(task.id), other: Number(other.id), decision }, scored as Similarity, by)
      if (held) keepOwners(held, by)
      if (held) decide(id, decision, by)
      return pairOf(database.prepare("SELECT * FROM task_pairs WHERE id = ?").get(id) as Row)
    })
  }
  const sameInbox = (a: Row, b: Row) => {
    if (Number(a.id) === Number(b.id)) throw new CliError("validation_error", "a task is not a duplicate of itself")
    if (Number(a.project_id) !== Number(b.project_id))
      throw new CliError("validation_error", "the two tasks belong to different accounts or projects")
  }
  const ref = (row: Row) => `task:${taskIdOf(database, Number(row.id))}`
  const mergedInto = (row: Row) =>
    database
      .prepare(
        `SELECT id, to_id FROM links WHERE from_type = 'task' AND from_id = ? AND to_type = 'task' AND kind = ${linkKind("duplicate-of")} ` +
          "AND anchor IS NULL ORDER BY id DESC LIMIT 1",
      )
      .get(Number(row.id))
  /** The messages a task stands on: its source, and every message linked to it. */
  const messagesOf = (row: Row): string[] => {
    const linked = database
      .prepare(
        "SELECT l.to_type, l.to_id, l.target_text FROM links l WHERE l.from_type = 'task' AND l.from_id = ? AND " +
          "(l.to_type = 'message' OR (l.to_id IS NULL AND l.target_text LIKE 'msg:%')) ORDER BY l.id",
      )
      .all(Number(row.id))
      .map((link) => (link.to_type === "message" ? `message:${String(link.to_id)}` : String(link.target_text)))
    const source = row.source_locator == null ? [] : [String(row.source_locator)]
    return [...new Set([...source.filter((one) => one.startsWith("msg:")), ...linked])]
  }
  /** Links a message to a task as evidence; false when it already was. */
  const linkMessage = (task: Row, message: string, by: Author): boolean => {
    const thing = message.startsWith("message:")
      ? { type: "message", id: Number(message.slice("message:".length)) }
      : thingOf(database, message)
    const held = database
      .prepare(
        `SELECT 1 FROM links WHERE from_type = 'task' AND from_id = ? AND kind = ${linkKind("evidence")} AND ` +
          "((to_type = ? AND to_id = ?) OR (to_id IS NULL AND target_text = ?))",
      )
      .get(Number(task.id), thing?.type ?? null, thing?.id ?? null, message)
    if (held) return false
    const origin = by === "owner" ? "owner" : "suggested"
    if (thing?.type === "message")
      database
        .prepare(
          "INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, confirmed, created_at, author, updated_at) " +
            `VALUES ('task', ?, 'message', ?, ${linkKind("evidence")}, ?, 1, ?, ?, ?)`,
        )
        .run(Number(task.id), thing.id, origin, now(), origin === "owner" ? "owner" : null, now())
    else insertLink(context, { from: ref(task), targetText: message, kind: "evidence", origin })
    return true
  }

  const followUp = async (row: Row, candidates: readonly SimilarTask[], by: Author) =>
    write(database, () => {
      for (const one of candidates) {
        if (!isClosedState(one.status) || one.band === "different") continue
        const closed = required(one.key)
        if (mergedInto(closed)) continue
        validateTaskRelation(database, Number(row.id), Number(closed.id), "follow-up-of")
        const { actor } = authorActor(context, by)
        const at = now()
        database
          .prepare(
            "INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, confirmed, author, created_at, updated_at) " +
              `VALUES ('task', ?, 'task', ?, ${linkKind("follow-up-of")}, ?, 1, ?, ?, ?)`,
          )
          .run(
            Number(row.id),
            Number(closed.id),
            by === "owner" ? "owner" : "suggested",
            by === "owner" ? "owner" : null,
            at,
            at,
          )
        recordTaskEvent(
          database,
          Number(row.id),
          actor,
          "linked",
          { relation: [null, { kind: "follow-up-of", to: ref(closed) }] },
          at,
        )
        return sideOf(closed.id) ?? undefined
      }
      return undefined
    })

  return {
    reviewDuplicates: async (task, { linked = false } = {}) => {
      const row = required(task)
      const alike = (await similarity.similar({ task: String(row.key) }, { limit: 40 })).filter(
        (one) => one.band !== "different",
      )
      if (!linked) await followUp(row, alike, { bot: "rule" })
      const found = linked ? alike : alike.filter((one) => !isClosedState(one.status))
      if (found.length === 0) return 0
      return write(database, () => {
        let added = 0
        for (const one of found) {
          const other = required(one.key)
          if (heldPair(Number(row.id), Number(other.id))) continue
          // Checked again after a link, the task may be the older one; the newer stays the would-be duplicate.
          const [newer, older] = Number(other.created_at) > Number(row.created_at) ? [other, row] : [row, other]
          insertPair({ task: Number(newer.id), other: Number(older.id), decision: "review" }, one, null)
          added += 1
        }
        return added
      })
    },

    followUp: async (task, candidates, by) => followUp(required(task), candidates, by),

    pairs: async (account, { decision, limit, offset }) =>
      read(database, () => {
        const project = database.prepare("SELECT id FROM projects WHERE key = ?").get(inboxKey(account))
        if (!project) return []
        return database
          .prepare(
            "SELECT p.* FROM task_pairs p JOIN tasks a ON a.id = p.task_id JOIN tasks b ON b.id = p.other_id " +
              "WHERE p.decision = ? AND a.project_id = ? AND b.project_id = ? AND a.deleted_at IS NULL AND b.deleted_at IS NULL " +
              "ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?",
          )
          .all(decision, Number(project.id), Number(project.id), limit, offset)
          .map(pairOf)
      }),

    recordPair: async ({ task, source, other, decision, similarity: scored, by }) => {
      const otherRow = required(other)
      const taskRow = task === undefined ? undefined : required(task)
      write(database, () => {
        const held = taskRow
          ? heldPair(Number(taskRow.id), Number(otherRow.id))
          : database
              .prepare("SELECT * FROM task_pairs WHERE task_id IS NULL AND source_locator = ? AND other_id = ?")
              .get(source ?? null, Number(otherRow.id))
        if (held) decide(Number(held.id), decision, by)
        else
          insertPair(
            {
              task: taskRow ? Number(taskRow.id) : null,
              ...(source === undefined ? {} : { source }),
              other: Number(otherRow.id),
              decision,
            },
            scored,
            by,
          )
      })
    },

    decidePair: async (task, other, decision, by) => {
      const a = required(task)
      const b = required(other)
      sameInbox(a, b)
      return settle(a, b, decision, by)
    },

    merge: async (dup, into, by) => {
      const a = required(dup)
      const b = required(into)
      sameInbox(a, b)
      if (isClosedState(String(a.status)))
        throw new CliError(
          "validation_error",
          `task ${String(a.key)} is already ${String(a.status)}; a merge closes an open task — reopen it with tasks unmerge if a merge closed it`,
          { reason: "task.closed" },
        )
      const onward = mergedInto(b)
      if (onward)
        throw new CliError(
          "validation_error",
          `task ${String(b.key)} was merged into ${String(sideOf(onward.to_id)?.key)}; merge into that one`,
          { reason: "task.merged" },
        )
      const scored = heldPair(Number(a.id), Number(b.id))
        ? undefined
        : await similarity.compare({ task: String(a.key) }, String(b.key))
      return write(database, () => {
        validateTaskRelation(database, Number(a.id), Number(b.id), "duplicate-of")
        const { actor } = authorActor(context, by)
        const at = now()
        let linked = 0
        for (const message of messagesOf(a)) if (linkMessage(b, message, by)) linked += 1
        const reason = `duplicate of ${String(b.key)}`
        database
          .prepare(
            "UPDATE tasks SET status = 'dismissed', closed_at = ?, closed_by_type = ?, closed_by_id = ?, close_reason = ?, " +
              `close_reason_folded = ?, claimed_by = NULL, claimed_until = NULL, ${CLEAR_SUGGESTION}, updated_at = ? WHERE id = ?`,
          )
          .run(at, actor.type, actor.id, reason, folded(reason), at, Number(a.id))
        recordTaskEvent(database, Number(a.id), actor, "status", { status: ["open", "dismissed"] }, at)
        database
          .prepare(
            "INSERT INTO links (from_type, from_id, to_type, to_id, kind, source, confirmed, author, created_at, updated_at) " +
              `VALUES ('task', ?, 'task', ?, ${linkKind("duplicate-of")}, ?, 1, ?, ?, ?)`,
          )
          .run(
            Number(a.id),
            Number(b.id),
            by === "owner" ? "owner" : "suggested",
            by === "owner" ? "owner" : null,
            at,
            at,
          )
        recordTaskEvent(
          database,
          Number(a.id),
          actor,
          "linked",
          { relation: [null, { kind: "duplicate-of", to: ref(b) }] },
          at,
        )
        const held = heldPair(Number(a.id), Number(b.id))
        const id = held
          ? Number(held.id)
          : insertPair({ task: Number(a.id), other: Number(b.id), decision: "merged" }, scored as Similarity, by)
        if (held) keepOwners(held, by)
        if (held) decide(id, "merged", by)
        return { pair: pairOf(database.prepare("SELECT * FROM task_pairs WHERE id = ?").get(id) as Row), linked }
      })
    },

    unmerge: async (dup, by) => {
      const a = required(dup)
      const relation = mergedInto(a)
      if (!relation)
        throw new CliError("validation_error", `task ${String(a.key)} was not merged into another task`, {
          reason: "task.not-merged",
        })
      const b = database.prepare("SELECT * FROM tasks WHERE id = ?").get(Number(relation.to_id)) as Row
      // A merge made with tasks link --kind duplicate-of left no pair; the undo still labels one.
      const scored = heldPair(Number(a.id), Number(b.id))
        ? undefined
        : await similarity.compare({ task: String(a.key) }, String(b.key))
      return write(database, () => {
        const { actor } = authorActor(context, by)
        const at = now()
        if (database.prepare("DELETE FROM links WHERE id = ?").run(Number(relation.id)).changes === 0)
          throw new CliError("validation_error", `task ${String(a.key)} was unmerged meanwhile`, {
            reason: "task.not-merged",
          })
        recordTaskEvent(
          database,
          Number(a.id),
          actor,
          "unlinked",
          { relation: [{ kind: "duplicate-of", to: ref(b) }, null] },
          at,
        )
        const status = String(
          (database.prepare("SELECT status FROM tasks WHERE id = ?").get(Number(a.id)) as Row).status,
        )
        if (status !== "open") {
          database
            .prepare(
              "UPDATE tasks SET status = 'open', closed_at = NULL, closed_by_type = NULL, closed_by_id = NULL, " +
                "close_reason = NULL, close_reason_folded = NULL, close_certainty = NULL, updated_at = ? WHERE id = ?",
            )
            .run(at, Number(a.id))
          recordTaskEvent(database, Number(a.id), actor, "status", { status: [status, "open"] }, at)
        }
        const held = heldPair(Number(a.id), Number(b.id))
        const id = held
          ? Number(held.id)
          : insertPair({ task: Number(a.id), other: Number(b.id), decision: "unmerged" }, scored as Similarity, by)
        if (held) keepOwners(held, by)
        if (held) decide(id, "unmerged", by)
        return { pair: pairOf(database.prepare("SELECT * FROM task_pairs WHERE id = ?").get(id) as Row) }
      })
    },
  }
}
