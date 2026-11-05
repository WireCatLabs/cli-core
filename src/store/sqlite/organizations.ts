import { CliError } from "@wirecat/cli-base"
import { evaluate, type QueryAst, walkQuery } from "@wirecat/cli-base/query"
import { ORGANIZATIONS_QUERY } from "../knowledge-query.js"
import type { Organization } from "./knowledge.js"
import type { StoreContext } from "./open.js"
import { queryFilter } from "./query-filter.js"
import { thingOf } from "./things.js"
import { write } from "./transaction.js"

type Row = Record<string, unknown>

export const organizationOf = (row: Row): Organization => ({
  id: String(row.id),
  ref: `organization:${row.id}`,
  kind: row.kind as Organization["kind"],
  name: String(row.name),
  scope: row.scope as Organization["scope"],
  createdAt: new Date(Number(row.created_at)).toISOString(),
})

export interface OrganizationsStore {
  organizations(query?: QueryAst): Promise<Organization[]>
  /** Renames an organization given as `organization:<id>` or by its id; its kind and scope stay. */
  updateOrganization(organization: string, input: { name: string }): Promise<Organization>
}

export const organizationsStoreOver = ({ database, now }: StoreContext): OrganizationsStore => ({
  organizations: async (query) => {
    // `lower()` folds ASCII only and an organization has no folded copy, so a name filter runs on the rows.
    if (query && walkQuery(query.root).some((node) => node.field === "name"))
      return (database.prepare("SELECT * FROM organizations WHERE deleted_at IS NULL ORDER BY name, id").all() as Row[])
        .map(organizationOf)
        .filter((one) => evaluate(query, ORGANIZATIONS_QUERY.fields, { ...one, created_at: one.createdAt }))
        .slice(0, 500)
    const where =
      query &&
      queryFilter(query, {
        id: { type: "kw", sql: "CAST(id AS TEXT)" },
        kind: { type: "enum", sql: "kind" },
        scope: { type: "enum", sql: "scope" },
        created_at: { type: "time", sql: "created_at" },
      })
    return database
      .prepare(
        `SELECT * FROM organizations WHERE deleted_at IS NULL${where ? ` AND (${where.sql})` : ""} ORDER BY name, id LIMIT 500`,
      )
      .all(...(where?.params ?? []))
      .map(organizationOf)
  },
  updateOrganization: async (organization, { name }) =>
    write(database, () => {
      const title = name.trim()
      if (!title || title.length > 200) throw new CliError("validation_error", "text takes 1–200 characters")
      const thing = thingOf(database, organization.includes(":") ? organization : `organization:${organization}`)
      const row =
        thing?.type === "organization" &&
        database
          .prepare("UPDATE organizations SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL RETURNING *")
          .get(title, now(), thing.id)
      if (!row) throw new CliError("not_found", `no organization ${organization}`)
      return organizationOf(row)
    }),
})
