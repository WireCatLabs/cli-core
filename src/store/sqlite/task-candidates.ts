import { CliError } from "@wirecat/cli-base"
import { isLocator } from "../../domain/locator.js"
import { DEFAULT_STEMMERS, type Stemmer } from "../../search/stem.js"
import type { TaskAmount } from "../../search/task-signature.js"
import {
  compareViews,
  type PreparedTask,
  prepareTask,
  rankCandidates,
  type Similarity,
} from "../../search/task-similarity.js"
import { linkKind } from "./link-kinds.js"
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
/** The newest messages linked to a task that the comparison reads: enough for a reminder, cheap on a long thread. */
export const LINKED_MESSAGES = 5
/** A message linked by any of these is about the task; `answered-by` is the owner's own answer. */
const ABOUT_TASK = ["related-to", "evidence", "created-from"] as const

type Row = Record<string, unknown>

type Message = { message: number; text: string; sentAt: Date; person?: string }

type Side = {
  row?: number
  project: number
  /** Read only for the subject and the chosen candidates: the window holds up to 2000 tasks. */
  linked?: Message[]
  title: string
  description: string
  category?: string
  source?: Message
  amount?: TaskAmount | null
  due?: Date | null
  person?: string
  createdAt: Date
}

const PLACEHOLDER = (row: Row) => `${String(row.type)} — ${String(row.source_locator ?? "")}`

export const taskSimilarityOver = (context: StoreContext): TaskSimilarity => {
  const { database, now } = context
  const stemmerFor = stemmerCache()

  const MESSAGE =
    "SELECT m.id, m.text, m.sent_at, m.outgoing, p.id AS person, p.owner FROM messages m " +
    "LEFT JOIN identity_links il ON il.identity_id = m.sender_identity_id LEFT JOIN persons p ON p.id = il.person_id"

  const messageOf = (row: Row): Message => {
    // The owner's own message (a promise) names no other person: every promise would match every promise.
    const own = Number(row.outgoing) === 1 || Number(row.owner) === 1
    return {
      message: Number(row.id),
      text: String(row.text ?? ""),
      sentAt: new Date(Number(row.sent_at)),
      ...(own || row.person == null ? {} : { person: `person:${row.person}` }),
    }
  }

  const sourceOf = (locator: unknown): Message | undefined => {
    if (typeof locator !== "string" || !isLocator(locator)) return undefined
    let thing: ReturnType<typeof thingOf>
    try {
      thing = thingOf(database, locator)
    } catch {
      return undefined
    }
    if (thing?.type !== "message") return undefined
    const row = database.prepare(`${MESSAGE} WHERE m.id = ?`).get(thing.id)
    return row ? messageOf(row) : undefined
  }

  const linkedOf = (side: Side): Side => {
    if (side.row === undefined || side.linked) return side
    const linked = database
      .prepare(
        `${MESSAGE} JOIN links l ON l.to_type = 'message' AND l.to_id = m.id WHERE l.from_type = 'task' AND l.from_id = ? ` +
          `AND l.kind IN (${ABOUT_TASK.map(linkKind).join(", ")}) AND m.deleted_at IS NULL AND m.id <> ? ` +
          "GROUP BY m.id ORDER BY m.sent_at DESC, m.id DESC LIMIT ?",
      )
      .all(side.row, side.source?.message ?? -1, LINKED_MESSAGES)
      .map(messageOf)
    return { ...side, linked }
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

  // Two tasks an agent took from one message are two jobs it chose to split: that message's words say nothing.
  const sameSource = (a: Side, b: Side) => a.source !== undefined && a.source.message === b.source?.message

  const messagesOf = (side: Side): Message[] => [...(side.source ? [side.source] : []), ...(side.linked ?? [])]

  /** The task's own text, then that text with each message it stands on: its source and its newest linked ones. */
  const viewsOf = (side: Side, stemmer: Stemmer): PreparedTask[] => {
    const view = (message?: Message): PreparedTask => {
      // The source's sender is already the task's person, unless an agent named another (`--person`).
      const person = message === side.source ? side.person : (message?.person ?? side.person)
      return prepareTask(
        {
          title: side.title,
          description: side.description,
          // When the job came up, not when a task was written for it: an agent going through history writes many
          // tasks in a minute, and "tomorrow" in a message means the day after it was sent.
          createdAt: side.source?.sentAt ?? side.createdAt,
          ...(person === undefined ? {} : { person }),
          ...(side.category === undefined ? {} : { category: side.category }),
          ...(side.amount === undefined ? {} : { amount: side.amount }),
          ...(side.due === undefined ? {} : { due: side.due }),
          ...(message === undefined ? {} : { message: { text: message.text, sentAt: message.sentAt } }),
        },
        stemmer,
      )
    }
    return [view(), ...messagesOf(side).map(view)]
  }

  const chainOf = (side: Side): Set<number> =>
    new Set(messagesOf(side).flatMap(({ message }) => [...replyChain(message)]))

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
      const one = linkedOf(side)
      const otherSide = linkedOf(sideOf(row))
      const chain = chainOf(one)
      if (sameSource(one, otherSide))
        return compareViews(viewsOf(one, stemmer).slice(0, 1), viewsOf(otherSide, stemmer).slice(0, 1))
      return compareViews(viewsOf(one, stemmer), viewsOf(otherSide, stemmer), {
        replyChain: messagesOf(otherSide).some(({ message }) => chain.has(message)),
      })
    },
    similar: async (subject, { limit = 10 } = {}) => {
      const named = subjectOf(subject)
      if (!named) return []
      const side = linkedOf(named)
      drainCorpus(database, CORPORA.task, stemmerFor)
      const stemmer = stemmerFor(storeStemmers(database) ?? DEFAULT_STEMMERS)
      const since = now() - RECENTLY_CLOSED_MS
      const live =
        "t.project_id = ? AND t.deleted_at IS NULL AND t.id <> ? AND (t.status NOT IN ('done', 'dismissed') OR t.closed_at >= ?)"
      const scope = [side.project, side.row ?? -1, since]

      const found = new Map<number, Set<CandidateLookup>>()
      const add = (id: number, by: CandidateLookup) => found.set(id, (found.get(id) ?? new Set()).add(by))

      const views = viewsOf(side, stemmer)
      const stems = [...new Set(views.flatMap((view) => [...view.stems]))]
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
      const chain = chainOf(side)
      const inChain = (other: Side) => messagesOf(other).some(({ message }) => chain.has(message))
      // No lookup by chat: a chat holds many unrelated tasks, and one request can arrive in two chats.
      const newest = (by: CandidateLookup, same: (other: Side) => boolean) => {
        for (const [id] of [...sides].filter(([, one]) => same(one.side)).slice(0, FIELD_LIMIT)) add(id, by)
      }
      for (const [id, { side: other }] of sides) if (inChain(other)) add(id, "reply")
      if (chain.size > 0)
        for (const one of database
          .prepare(
            `SELECT DISTINCT t.id FROM links l JOIN tasks t ON t.id = l.from_id WHERE l.from_type = 'task' AND ` +
              `l.to_type = 'message' AND l.kind IN (${ABOUT_TASK.map(linkKind).join(", ")}) AND ` +
              `l.to_id IN (${[...chain].map(() => "?").join(", ")}) AND ${live}`,
          )
          .all(...chain, ...scope))
          add(Number(one.id), "reply")
      const persons = new Set(views.flatMap(({ person }) => (person === undefined ? [] : [person])))
      if (persons.size > 0) newest("person", (other) => other.person !== undefined && persons.has(other.person))
      if (side.category) newest("category", (other) => other.category === side.category)

      const order: CandidateLookup[] = ["reply", "text", "person", "category"]
      const rank = (by: Set<CandidateLookup>) => Math.min(...[...by].map((one) => order.indexOf(one)))
      const chosen = [...found].sort(([, a], [, b]) => rank(a) - rank(b)).slice(0, CANDIDATE_LIMIT)
      const rows = new Map(
        chosen.map(([id]) => {
          const known = sides.get(id)
          const row = known?.row ?? (rowOf(id) as Row)
          return [id, { row, side: linkedOf(known?.side ?? sideOf(row)) }]
        }),
      )
      const ranked = rankCandidates(
        views,
        chosen.map(([id]) => {
          const other = rows.get(id)?.side as Side
          if (sameSource(side, other))
            return { id, views: viewsOf(other, stemmer).slice(0, 1), subjectViews: views.slice(0, 1) }
          return { id, views: viewsOf(other, stemmer), replyChain: inChain(other) }
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
