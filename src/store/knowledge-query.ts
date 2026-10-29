import { type QueryRegistry, queryFieldsOf } from "@wirecat/cli-base/query"
import { organization, project, reminder } from "../entities/knowledge-lists.js"

export { organization, project, reminder }
export const ORGANIZATIONS_QUERY: QueryRegistry = {
  entity: "organization",
  backend: "sql",
  fields: queryFieldsOf(organization, {
    native: ["id", "kind", "scope", "created_at"],
    examples: { id: "id:1", kind: "kind:company", scope: "scope:work", created_at: "created_at>=2026-01-01" },
  }),
}
export const PROJECTS_QUERY: QueryRegistry = {
  entity: "project",
  backend: "sql",
  fields: queryFieldsOf(project, {
    native: ["id", "key", "name", "kind", "type", "organization_id", "scope", "created_at"],
    examples: {
      id: "id:1",
      key: "key:SMP",
      name: "name:*tart*",
      kind: "kind:inbox",
      type: "type:work",
      organization_id: "organization_id:1",
      scope: "scope:work",
      created_at: "created_at>=2026-01-01",
    },
  }),
}
export const REMINDERS_QUERY: QueryRegistry = {
  entity: "reminder",
  backend: "sql",
  fields: queryFieldsOf(reminder, {
    native: ["id", "state", "due_at", "revision"],
    examples: { id: "id:1", state: "state:pending", due_at: "due_at>=2026-01-01", revision: "revision>1" },
  }),
}
