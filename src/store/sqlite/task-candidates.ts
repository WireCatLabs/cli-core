import { CliError } from "@wirecat/cli-base"
import { isLocator } from "../../domain/locator.js"
import { DEFAULT_STEMMERS, type Stemmer } from "../../search/stem.js"
import type { TaskAmount } from "../../search/task-signature.js"
import {
  compareTasks,
  type PreparedTask,
  prepareTask,
  rankCandidates,
  type Similarity,
  taskStemsOf,
} from "../../search/task-similarity.js"
import { CORPORA, drainCorpus } from "./note-index.js"
import type { StoreContext } from "./open.js"
import { stemmerCache, storeStemmers } from "./stems.js"
import { inboxKey } from "./task-keys.js"
import { taskRowOf, thingOf } from "./things.js"

/** A task not written yet, as `tasks add` will see it: what the comparison reads from a stored one. */
export interface TaskDraft {
  title: string
  description?: string | null
  /** The `msg:` locator it comes from: its sender and reply chain. */
  source?: string
  /** `person:<id>`; read from the source message's sender when absent. */
  person?: string
  category?: string
  amount?: TaskAmount | null
  due?: Date | null
}

/** Which lookup brought a candidate in; one task may come by several. */
export type CandidateLookup = "text" | "person" | "category" | "reply"

export type SimilarTask = Similarity & {
  ref: string
  key: string
  title: string
  status: string
  createdAt: string
  foundBy: CandidateLookup[]
}

export type SimilarSubject = { task: string } | { account: string; draft: TaskDraft }

export interface TaskSimilarity {
  /**
   * The tasks of the same project that may be the same job, scored and best first: open ones, and ones closed in
   * the last 14 days. Never refuses or merges; `tasks add` and the review list decide on the bands.
   */
  similar(subject: SimilarSubject, options?: { limit?: number }): Promise<SimilarTask[]>
  /** One pair scored as `similar` scores a candidate, whichever lookup would or would not have found it. */
  compare(subject: SimilarSubject, other: string): Promise<Similarity>
}

const DAY = 86_400_000
/** Tasks closed longer ago are done with: a new message about them is new work, or a follow-up. */
export const RECENTLY_CLOSED_MS = 14 * DAY
const TEXT_LIMIT = 20
/** Per lookup by a field many tasks share — the same person, the same category — newest first. */
const FIELD_LIMIT = 10
export const CANDIDATE_LIMIT = 40
const WINDOW_LIMIT = 2000
const REPLY_DEPTH = 20

type Row = Record<string, unknown>

type Source = { message: number; person?: string }

type Side = {
  row?: number
  project: number
  title: string
  description: string
  category?: string
  source?: Source
  amount?: TaskAmount | null
  due?: Date | null
  person?: string
  createdAt: Date
}

const PLACEHOLDER = (row: Row) => `${String(row.type)} — ${String(row.source_locator ?? "")}`

export const taskSimilarityOver = (context: StoreContext): TaskSimilarity => {
  const { database, now } = context
  const stemmerFor = stemmerCache()

  const sourceOf = (locator: unknown): Source | undefined => {
    if (typeof locator !== "string" || !isLocator(locator)) return undefined
    let thing: ReturnType<typeof thingOf>
    try {
      thing = thingOf(database, locator)
    } catch {
      return undefined
    }
    if (thing?.type !== "message") return undefined
    const sender = database
      .prepare(
        "SELECT m.outgoing, p.id AS person, p.owner FROM messages m " +
          "LEFT JOIN identity_links l ON l.identity_id = m.sender_identity_id LEFT JOIN persons p ON p.id = l.person_id " +
          "WHERE m.id = ?",
      )
      .get(thing.id)
    // The owner's own message (a promise) names no other person: every promise would match every promise.
    const own = Number(sender?.outgoing) === 1 || Number(sender?.owner) === 1
    return { message: thing.id, ...(own || sender?.person == null ? {} : { person: `person:${sender.person}` }) }
  }

  const sideOf = (row: Row): Side => {
    const source = sourceOf(row.source_locator)
    const person = source?.person
    return {
      row: Number(row.id),
      project: Number(row.project_id),
      title: String(row.title) === PLACEHOLDER(row) ? "" : String(row.title),
      description: row.description == null ? "" : String(row.description),
      ...(row.category == null ? {} : { category: String(row.category) }),
      ...(source ? { source } : {}),
      ...(person ? { person } : {}),
      ...(row.due_at == null ? {} : { due: new Date(Number(row.due_at)) }),
      createdAt: new Date(Number(row.created_at)),
    }
  }

  const prepared = (side: Side, stemmer: Stemmer): PreparedTask =>
    prepareTask(
      {
        title: side.title,
        description: side.description,
        createdAt: side.createdAt,
        ...(side.person === undefined ? {} : { person: side.person }),
        ...(side.category === undefined ? {} : { category: side.category }),
        ...(side.amount === undefined ? {} : { amount: side.amount }),
        ...(side.due === undefined ? {} : { due: side.due }),
      },
      stemmer,
    )

  /** The source message, the messages it replies to and the replies to it, in one chat. */
  const replyChain = (message: number): Set<number> => {
    const up = database
      .prepare(
        "WITH RECURSIVE up(id, chat_id, reply, depth) AS (" +
          "SELECT id, chat_id, reply_to_external_id, 0 FROM messages WHERE id = ? " +
          "UNION SELECT m.id, m.chat_id, m.reply_to_external_id, up.depth + 1 FROM messages m " +
          "JOIN up ON m.chat_id = up.chat_id AND m.external_id = up.reply WHERE up.depth < ?) SELECT id FROM up",
      )
      .all(message, REPLY_DEPTH)
    const down = database
      .prepare(
        "WITH RECURSIVE down(id, chat_id, external_id, depth) AS (" +
          "SELECT id, chat_id, external_id, 0 FROM messages WHERE id = ? " +
          "UNION SELECT m.id, m.chat_id, m.external_id, down.depth + 1 FROM messages m " +
          "JOIN down ON m.chat_id = down.chat_id AND m.reply_to_external_id = down.external_id " +
          "WHERE m.deleted_at IS NULL AND down.depth < ?) SELECT id FROM down",
      )
      .all(message, REPLY_DEPTH)
    return new Set([...up, ...down].map((one) => Number(one.id)))
  }

  const COLUMNS =
    "t.id, t.project_id, t.key, t.package_id, t.title, t.description, t.type, t.status, t.source_locator, " +
    "t.created_at, t.due_at, t.category"

  const rowOf = (id: number) =>
    database.prepare(`SELECT ${COLUMNS} FROM tasks t WHERE t.id = ? AND t.deleted_at IS NULL`).get(id)

  const subjectOf = (subject: SimilarSubject): Side | undefined => {
    if ("task" in subject) {
      const bare = subject.task.startsWith("task:") ? subject.task.slice("task:".length) : subject.task
      const id = taskRowOf(database, bare)
      const row = id === undefined ? undefined : rowOf(id)
      if (!row) throw new CliError("not_found", `no task ${subject.task}`)
      return sideOf(row)
    }
    const project = database.prepare("SELECT id FROM projects WHERE key = ?").get(inboxKey(subject.account))
    if (!project) return undefined
    const { draft } = subject
    const source = draft.source === undefined ? undefined : sourceOf(draft.source)
    const person = draft.person ?? source?.person
    return {
      project: Number(project.id),
      title: draft.title,
      description: draft.description ?? "",
      ...(draft.category === undefined ? {} : { category: draft.category }),
      ...(source ? { source } : {}),
      ...(person ? { person } : {}),
      ...(draft.amount === undefined ? {} : { amount: draft.amount }),
      ...(draft.due === undefined ? {} : { due: draft.due }),
      createdAt: new Date(now()),
    }
  }

  return {
    compare: async (subject, other) => {
      const side = subjectOf(subject)
      const id = taskRowOf(database, other.startsWith("task:") ? other.slice("task:".length) : other)
      const row = id === undefined ? undefined : rowOf(id)
      if (!side || !row) throw new CliError("not_found", `no task ${other}`)
      const stemmer = stemmerFor(storeStemmers(database) ?? DEFAULT_STEMMERS)
      const otherSide = sideOf(row)
      const chain = side.source ? replyChain(side.source.message) : new Set<number>()
      return compareTasks(prepared(side, stemmer), prepared(otherSide, stemmer), {
        replyChain: otherSide.source !== undefined && chain.has(otherSide.source.message),
      })
    },
    similar: async (subject, { limit = 10 } = {}) => {
      const side = subjectOf(subject)
      if (!side) return []
      drainCorpus(database, CORPORA.task, stemmerFor)
      const stemmer = stemmerFor(storeStemmers(database) ?? DEFAULT_STEMMERS)
      const since = now() - RECENTLY_CLOSED_MS
      const live = "t.project_id = ? AND t.deleted_at IS NULL AND t.id <> ? AND (t.status = 'open' OR t.closed_at >= ?)"
      const scope = [side.project, side.row ?? -1, since]

      const found = new Map<number, Set<CandidateLookup>>()
      const add = (id: number, by: CandidateLookup) => found.set(id, (found.get(id) ?? new Set()).add(by))

      const stems = [...taskStemsOf(`${side.title}\n${side.description}`, stemmer)]
      if (stems.length > 0) {
        const match = `stems : (${stems.map((stem) => `"${stem.replaceAll('"', '""')}"`).join(" OR ")})`
        for (const one of database
          .prepare(
            `SELECT t.id FROM task_stems s JOIN tasks t ON t.id = s.rowid WHERE task_stems MATCH ? AND ${live} ` +
              "ORDER BY bm25(task_stems) LIMIT ?",
          )
          .all(match, ...scope, TEXT_LIMIT))
          add(Number(one.id), "text")
      }

      const window = database
        .prepare(`SELECT ${COLUMNS} FROM tasks t WHERE ${live} ORDER BY t.created_at DESC, t.id DESC LIMIT ?`)
        .all(...scope, WINDOW_LIMIT)
      const sides = new Map(window.map((row) => [Number(row.id), { row, side: sideOf(row) }]))
      const chain = side.source ? replyChain(side.source.message) : new Set<number>()
      const inChain = (other: Side) => other.source !== undefined && chain.has(other.source.message)
      // No lookup by chat: a chat holds many unrelated tasks, and one request can arrive in two chats.
      const newest = (by: CandidateLookup, same: (other: Side) => boolean) => {
        for (const [id] of [...sides].filter(([, one]) => same(one.side)).slice(0, FIELD_LIMIT)) add(id, by)
      }
      for (const [id, { side: other }] of sides) if (inChain(other)) add(id, "reply")
      if (side.person) newest("person", (other) => other.person === side.person)
      if (side.category) newest("category", (other) => other.category === side.category)

      const order: CandidateLookup[] = ["reply", "text", "person", "category"]
      const rank = (by: Set<CandidateLookup>) => Math.min(...[...by].map((one) => order.indexOf(one)))
      const chosen = [...found].sort(([, a], [, b]) => rank(a) - rank(b)).slice(0, CANDIDATE_LIMIT)
      const rows = new Map(
        chosen.map(([id]) => {
          const known = sides.get(id)
          const row = known?.row ?? (rowOf(id) as Row)
          return [id, { row, side: known?.side ?? sideOf(row) }]
        }),
      )
      const ranked = rankCandidates(
        prepared(side, stemmer),
        chosen.map(([id]) => {
          const other = rows.get(id)?.side as Side
          return { id, task: prepared(other, stemmer), replyChain: inChain(other) }
        }),
      )
      return ranked.slice(0, Math.min(Math.max(limit, 1), CANDIDATE_LIMIT)).map(({ id, ...similarity }) => {
        const row = rows.get(id)?.row as Row
        return {
          ref: `task:${String(row.package_id ?? row.key)}`,
          key: String(row.key),
          title: String(row.title),
          status: String(row.status),
          createdAt: new Date(Number(row.created_at)).toISOString(),
          foundBy: order.filter((one) => found.get(id)?.has(one)),
          ...similarity,
        }
      })
    },
  }
}
