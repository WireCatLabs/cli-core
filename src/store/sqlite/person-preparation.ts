import { CliError } from "@wirecat/cli-base"
import type { AccountKey } from "../types.js"
import { linkKind } from "./link-kinds.js"
import type { StoreContext } from "./open.js"
import { taskIdOf } from "./things.js"
import { read } from "./transaction.js"

export interface PreparationFact {
  ref: string
  type: string
  statement: string
  subject: string | null
  project: string | null
  updatedAt: string
}
export interface PreparationNote {
  ref: string
  title: string | null
  text: string
  revision: number
  updatedAt: string
}
export interface PreparationTask {
  ref: string
  title: string
  role: string
  dueAt: string | null
  project: string
  source: string | null
  createdAt: string
}
export interface PersonPreparationRead {
  facts: { items: PreparationFact[]; hasMore: boolean }
  notes: { items: PreparationNote[]; hasMore: boolean }
  tasks: { items: PreparationTask[]; hasMore: boolean }
}

const GLOBAL_PROJECT = "SELECT id FROM main.projects WHERE account_id IS NULL AND deleted_at IS NULL"
const iso = (value: unknown) => (value == null ? null : new Date(Number(value)).toISOString())

/**
 * The accepted facts, the owner's notes and the open tasks about one person. A project bound to an account is that
 * account's: its facts never come along, and its tasks only when `accounts` holds it.
 */
export const personPreparation = (
  { database }: Pick<StoreContext, "database">,
  uid: string,
  { accounts, limit }: { accounts: readonly AccountKey[]; limit: number },
): PersonPreparationRead => {
  const person = Number(uid)
  if (!/^[1-9]\d*$/.test(uid) || !Number.isSafeInteger(person) || !Number.isSafeInteger(limit) || limit < 1)
    throw new CliError("validation_error", "person preparation takes a person id and a positive limit")
  const page = <T>(rows: T[]) => ({ items: rows.slice(0, limit), hasMore: rows.length > limit })
  return read(database, () => {
    const projects = `SELECT l.to_id FROM links l WHERE l.from_type='person' AND l.from_id=? AND l.to_type='project'
      AND l.kind=${linkKind("member-of")} AND l.confirmed=1 AND l.to_id IN (${GLOBAL_PROJECT})`
    const facts = database
      .prepare(
        `SELECT f.id,f.type,f.statement,f.subject_type,f.subject_id,f.project_id,f.updated_at FROM facts f
        WHERE f.status='accepted' AND f.deleted_at IS NULL
        AND ((f.subject_type='person' AND f.subject_id=?) OR (f.subject_type='project' AND f.subject_id IN (${projects}))
          OR f.project_id IN (${projects}))
        AND (f.subject_type IS NOT 'project' OR f.subject_id IN (${GLOBAL_PROJECT}))
        AND (f.project_id IS NULL OR f.project_id IN (${GLOBAL_PROJECT}))
        ORDER BY f.updated_at DESC, f.id DESC LIMIT ?`,
      )
      .all(person, person, person, limit + 1)
      .map((row) => ({
        ref: `fact:${row.id}`,
        type: String(row.type),
        statement: String(row.statement),
        subject: row.subject_type == null ? null : `${row.subject_type}:${row.subject_id}`,
        project: row.project_id == null ? null : `project:${row.project_id}`,
        updatedAt: iso(row.updated_at) as string,
      }))
    const notes = database
      .prepare(
        `SELECT n.id,n.title,n.body,n.revision,n.updated_at FROM notes n
        JOIN persons owner ON n.author_type='person' AND n.author_id=owner.id AND owner.owner=1
        WHERE n.deleted_at IS NULL
        AND ((n.notable_type='person' AND n.notable_id=?) OR EXISTS(SELECT 1 FROM links l WHERE l.from_type='note'
          AND l.from_id=n.id AND l.to_type='person' AND l.to_id=? AND l.kind=${linkKind("about")} AND l.confirmed=1))
        AND (n.notable_type='person' OR (n.notable_type='project' AND n.notable_id IN (${GLOBAL_PROJECT})))
        ORDER BY n.updated_at DESC, n.id DESC LIMIT ?`,
      )
      .all(person, person, limit + 1)
      .map((row) => ({
        ref: `note:${row.id}`,
        title: row.title == null ? null : String(row.title),
        text: String(row.body),
        revision: Number(row.revision),
        updatedAt: iso(row.updated_at) as string,
      }))
    const tasks = database
      .prepare(
        `SELECT t.id,t.title,t.due_at,t.project_id,t.source_locator,t.created_at,group_concat(DISTINCT ta.role) AS role
        FROM task_assignments ta JOIN tasks t ON t.id=ta.task_id JOIN main.projects p ON p.id=t.project_id
        WHERE ta.assignee_type='person' AND ta.assignee_id=? AND t.deleted_at IS NULL AND t.status NOT IN ('done','dismissed')
        AND p.deleted_at IS NULL AND (p.account_id IS NULL OR p.account_id IN (SELECT a.id FROM accounts a
          JOIN json_each(?) k ON a.provider=json_extract(k.value,'$.provider')
          AND a.external_id=json_extract(k.value,'$.account')))
        GROUP BY t.id ORDER BY t.due_at IS NULL, t.due_at, t.created_at, t.id LIMIT ?`,
      )
      .all(person, JSON.stringify(accounts.map(({ provider, account }) => ({ provider, account }))), limit + 1)
      .map((row) => ({
        ref: `task:${taskIdOf(database, Number(row.id))}`,
        title: String(row.title),
        role: String(row.role),
        dueAt: iso(row.due_at),
        project: `project:${row.project_id}`,
        source: row.source_locator == null ? null : String(row.source_locator),
        createdAt: iso(row.created_at) as string,
      }))
    return { facts: page(facts), notes: page(notes), tasks: page(tasks) }
  })
}
