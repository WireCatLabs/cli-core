import { CliError } from "@wirecat/cli-base"
import {
  type FieldSpec,
  type FieldType,
  OPERATORS_BY_TYPE,
  type Predicate,
  type QueryAst,
  type QueryNode,
  walkQuery,
} from "@wirecat/cli-base/query"
import { TASK_TYPES } from "../../domain/knowledge.js"
import { taskWordsOf } from "../../search/task-similarity.js"
import { TASK_STATES } from "../../tasks/index.js"
import type { ColumnMap, Where } from "./query-filter.js"
import { INBOX_KEY_LENGTH } from "./task-keys.js"

export const TASK_SORTS = ["priority", "due", "created", "updated", "key", "state"] as const
export type TaskSort = (typeof TASK_SORTS)[number]

const field = (name: string, type: FieldType, example: string, more: Partial<FieldSpec> = {}): FieldSpec => ({
  name,
  type,
  operators: OPERATORS_BY_TYPE[type],
  example,
  ...more,
})

/** The query language of the owner's project tasks, every project at once; `text` takes the bare words. */
export const PROJECT_TASK_FIELDS: readonly FieldSpec[] = [
  field("state", "enum", "state:todo", { values: TASK_STATES }),
  field("kind", "enum", "kind:bug", { values: TASK_TYPES }),
  field("project", "kw", "project:HRB", {
    relation: "a project by its key or project:<id>; project:* is every project, and lists project tasks only",
  }),
  field("assignee", "kw", 'assignee:"person:12"', {
    relation: "who does it: any, none, or a person (person:12 in quotes, or the bare 12)",
  }),
  field("priority", "num", "priority:[0 TO 1]", { relation: "0 urgent … 4 low; NOT priority:* has none" }),
  field("due", "time", "due:[today TO 2026-12-31]", { relation: "the due date; NOT due:* has none" }),
  field("overdue", "bool", "overdue:true", { relation: "open work whose due date has passed" }),
  field("closed", "time", "closed:>=14d", { relation: "when it was done or dismissed" }),
  field("ready", "bool", "ready:true", { relation: "open work whose blocked-by tasks are all done" }),
  field("text", "txt", "text:invoice", { relation: "words of the title and description; a bare word means this" }),
]

const OPEN = "t.status NOT IN ('done', 'dismissed')"
const OWNER_PROJECTS = `SELECT id FROM projects WHERE deleted_at IS NULL AND length(key) <> ${INBOX_KEY_LENGTH}`
const ASSIGNED =
  "SELECT 1 FROM task_assignments a WHERE a.task_id = t.id AND a.assignee_type = 'person' AND a.role = 'assignee'"
/** A `blocked-by` task that is not done holds the task back; so does one deleted or out of reach. */
export const UNFINISHED_BLOCKER =
  "SELECT 1 FROM links l LEFT JOIN tasks b ON b.id = l.to_id LEFT JOIN projects bp ON bp.id = b.project_id " +
  "WHERE l.from_type = 'task' AND l.to_type = 'task' AND l.kind = 'blocked-by' AND l.from_id = t.id AND l.confirmed = 1 " +
  "AND l.anchor IS NULL AND (b.id IS NULL OR b.deleted_at IS NOT NULL OR bp.deleted_at IS NOT NULL OR b.status <> 'done')"

/** Every word a prefix, all of them required; a quoted phrase as one. `undefined` when nothing in it is a word. */
const wordsMatch = (node: Predicate): string | undefined => {
  const words = taskWordsOf(node.value.replaceAll("*", " "))
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
  if (words.length === 0) return undefined
  const quoted = (text: string) => `"${text.replaceAll('"', '""')}"`
  return `normalized_text : (${
    node.operator === "phrase" ? quoted(words.join(" ")) : words.map((word) => `${quoted(word)}*`).join(" AND ")
  })`
}

const projectWhere = (node: Predicate): Where => {
  if (node.operator === "wildcard" && node.value === "*") return { sql: "1", params: [] }
  const id = /^project:(\d+)$/.exec(node.value.trim())?.[1]
  if (id !== undefined) return { sql: "t.project_id = ?", params: [Number(id)] }
  const key = node.value.trim().toUpperCase()
  return {
    sql: `t.project_id IN (SELECT id FROM projects WHERE key ${node.operator === "wildcard" ? "GLOB" : "="} ?)`,
    params: [key],
  }
}

const assigneeWhere = (node: Predicate): Where => {
  const value = node.value.trim().toLowerCase()
  if (value === "any" || (node.operator === "wildcard" && value === "*"))
    return { sql: `EXISTS (${ASSIGNED})`, params: [] }
  if (value === "none") return { sql: `NOT EXISTS (${ASSIGNED})`, params: [] }
  const id = /^(?:person:)?(\d+)$/.exec(value)?.[1]
  if (id === undefined)
    throw new CliError("validation_error", `assignee: takes any, none or "person:<id>", not "${node.value}"`)
  return { sql: `EXISTS (${ASSIGNED} AND a.assignee_id = ?)`, params: [Number(id)] }
}

const truth = (node: Predicate, sql: string): Where => ({
  sql: node.value.toLowerCase() === "true" ? sql : `NOT (${sql})`,
  params: [],
})

/** `now` is when overdue is measured; one value per answer, so the list and its counts agree. */
export const projectTaskColumns = (now: number): ColumnMap => ({
  state: { type: "enum", sql: "t.status" },
  kind: { type: "enum", sql: "t.type" },
  project: { where: projectWhere },
  assignee: { where: assigneeWhere },
  priority: { type: "num", sql: "t.priority" },
  due: { type: "time", sql: "t.due_at" },
  closed: { type: "time", sql: "t.closed_at" },
  overdue: { where: (node) => truth(node, `${OPEN} AND t.due_at IS NOT NULL AND t.due_at < ${Number(now)}`) },
  ready: { where: (node) => truth(node, `${OPEN} AND NOT EXISTS (${UNFINISHED_BLOCKER})`) },
  text: {
    where: (node) => {
      const match = wordsMatch(node)
      const byKey = { sql: "t.key = ?", params: [node.value.trim().toUpperCase()] as (string | number)[] }
      if (match === undefined) return byKey
      return {
        sql: `(t.id IN (SELECT rowid FROM task_words WHERE task_words MATCH ?) OR ${byKey.sql})`,
        params: [match, ...byKey.params],
      }
    },
  },
})

/** Live tasks of the owner's projects; an account's inbox is listed by its account, never here. */
export const BOARD_SCOPE = `t.deleted_at IS NULL AND t.project_id IN (${OWNER_PROJECTS})`

const STATE_ORDER = `CASE t.status ${TASK_STATES.map((state, at) => `WHEN '${state}' THEN ${at}`).join(" ")} END`

/** The chosen order first, then priority, age and id, so a page boundary never splits a tie. */
export const boardOrder = (sort: TaskSort, descending: boolean): string => {
  const direction = descending ? "DESC" : "ASC"
  const first = {
    priority: [`coalesce(t.priority, 5) ${direction}`],
    due: ["t.due_at IS NULL", `t.due_at ${direction}`],
    created: [`t.created_at ${direction}`],
    updated: [`t.updated_at ${direction}`],
    key: [`(SELECT key FROM projects WHERE id = t.project_id) ${direction}`, `t.number ${direction}`],
    state: [`${STATE_ORDER} ${direction}`],
  }[sort]
  return [...first, "coalesce(t.priority, 5)", "t.created_at", "t.id"].join(", ")
}

/** The query without its required terms on `name`: a picker counts the choices its own filter hides. */
export const withoutField = (query: QueryAst | undefined, name: string): QueryAst | undefined => {
  if (query === undefined) return undefined
  const strip = (node: QueryNode): QueryNode | undefined => {
    if (walkQuery(node).every((leaf) => leaf.field === name)) return undefined
    if (node.kind === "predicate" || node.clauses.some((clause) => clause.occur === "should")) return node
    const clauses = node.clauses.flatMap((clause) => {
      const kept = strip(clause.node)
      return kept === undefined ? [] : [{ ...clause, node: kept }]
    })
    return clauses.length === 0 ? undefined : { ...node, clauses }
  }
  const root = strip(query.root)
  return root === undefined ? undefined : { ...query, root }
}
