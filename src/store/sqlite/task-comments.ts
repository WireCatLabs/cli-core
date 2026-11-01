import type { Actor } from "./actors.js"
import { type Author, authorActor } from "./memories.js"
import type { StoreContext } from "./open.js"
import { write } from "./transaction.js"

type Row = Record<string, unknown>

/** Who wrote a row with `author_type` and `author_id`, by the name the store holds now. */
export type NamedAuthor = { type: Actor["type"]; id: string; name: string | null; owner: boolean }

export interface TaskComment {
  ref: string
  text: string
  author: NamedAuthor | null
  at: string
}

export const authorNamed = (database: StoreContext["database"], row: Row): NamedAuthor | null => {
  if (row.author_type == null) return null
  const named = database
    .prepare(
      row.author_type === "bot"
        ? "SELECT name, 0 AS owner FROM bots WHERE id = ?"
        : "SELECT name, owner FROM persons WHERE id = ?",
    )
    .get(Number(row.author_id))
  return {
    type: row.author_type as Actor["type"],
    id: String(row.author_id),
    name: named?.name == null ? null : String(named.name),
    owner: Number(named?.owner) === 1,
  }
}

/** A task's comments are notes about it, oldest first. */
export const commentsOf = (database: StoreContext["database"], task: number): TaskComment[] =>
  database
    .prepare(
      "SELECT n.id, n.body, n.created_at, n.author_type, n.author_id FROM notes n " +
        "WHERE n.notable_type = 'task' AND n.notable_id = ? AND n.deleted_at IS NULL ORDER BY n.created_at, n.id",
    )
    .all(task)
    .map((row) => ({
      ref: `note:${row.id}`,
      text: String(row.body),
      author: authorNamed(database, row),
      at: new Date(Number(row.created_at)).toISOString(),
    }))

/** In the author's name, unlike `notes.addNote`, which is always the owner's. */
export const addComment = (context: StoreContext, task: number, body: string, by: Author): TaskComment => {
  const { database, now } = context
  const made = write(database, () => {
    const { actor } = authorActor(context, by)
    const at = now()
    return Number(
      database
        .prepare(
          "INSERT INTO notes (notable_type, notable_id, body, author_type, author_id, revision, created_at, updated_at) " +
            "VALUES ('task', ?, ?, ?, ?, 1, ?, ?) RETURNING id",
        )
        .get(task, body, actor.type, actor.id, at, at)?.id,
    )
  })
  return commentsOf(database, task).find((one) => one.ref === `note:${made}`) as TaskComment
}
