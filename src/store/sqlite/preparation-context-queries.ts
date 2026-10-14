import type { MeetingPreparationContext } from "../../meetings/index.js"
import { int, str } from "./events.js"
import { linkKind } from "./link-kinds.js"

type Row = Record<string, unknown>
interface ContextQuery<K extends keyof MeetingPreparationContext> {
  fields: string
  text: readonly string[]
  from: string
  map(row: Row): MeetingPreparationContext[K]["items"][number]
}
export const preparationQueries = {
  participants: {
    fields: "p.id, p.identity_id, p.display_name, l.person_id",
    text: ["p.display_name"],
    from: "FROM meeting_participants p LEFT JOIN identity_links l ON l.identity_id=p.identity_id WHERE p.meeting_id=? ORDER BY p.id LIMIT ?",
    map: (row: Row) => ({
      id: Number(row.id),
      identityId: Number(row.identity_id),
      displayName: str(row.display_name),
      personUid: row.person_id == null ? null : String(row.person_id),
    }),
  } satisfies ContextQuery<"participants">,
  projects: {
    fields: "p.id, p.key, p.name, l.id AS link_id",
    text: ["p.key", "p.name"],
    from: `FROM links l JOIN projects p ON p.id=l.to_id WHERE l.from_type='meeting' AND l.from_id=? AND l.to_type='project' AND l.kind=${linkKind("member-of")} AND l.confirmed=1 AND p.account_id IS NULL AND p.deleted_at IS NULL ORDER BY l.id LIMIT ?`,
    map: (row: Row) => ({
      ref: `project:${row.id}`,
      key: String(row.key),
      name: String(row.name),
      linkId: Number(row.link_id),
    }),
  } satisfies ContextQuery<"projects">,
  facts: {
    fields: "f.id, f.type, f.statement, f.updated_at",
    text: ["f.type", "f.statement"],
    from: "FROM facts f WHERE f.subject_type='meeting' AND f.subject_id=? AND f.status='accepted' AND f.deleted_at IS NULL ORDER BY f.updated_at DESC, f.id DESC LIMIT ?",
    map: (row: Row) => ({
      ref: `fact:${row.id}`,
      type: String(row.type),
      statement: String(row.statement),
      updatedAt: Number(row.updated_at),
    }),
  } satisfies ContextQuery<"facts">,
  tasks: {
    fields: "t.id, t.key, t.package_id, t.title, t.status, t.priority, t.source_locator",
    text: ["t.key", "t.package_id", "t.title", "t.status", "t.source_locator"],
    from: "FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.source_kind='meeting' AND t.source_group=? AND (t.source_locator=t.source_group OR substr(t.source_locator,1,length(t.source_group)+1)=t.source_group||'/') AND t.deleted_at IS NULL AND p.deleted_at IS NULL AND (p.account_id IS NULL OR p.account_id=?) ORDER BY t.id DESC LIMIT ?",
    map: (row: Row) => ({
      ref: `task:${row.package_id ?? row.key}`,
      key: String(row.key),
      title: String(row.title),
      status: String(row.status),
      priority: int(row.priority),
      source: str(row.source_locator),
    }),
  } satisfies ContextQuery<"tasks">,
}
