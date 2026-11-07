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
  /**
   * The owner says whether an organization is one of his own; a CRM sync never changes his word. `null` hands it back
   * to the CRM's own-company flag.
   */
  setOwnOrganization(organization: string, own: boolean | null): Promise<{ ref: string; own: boolean }>
  /** The owner's own companies: the owner's mark, else a CRM's own-company flag (`metadata.own`). */
  ownOrganizations(): Promise<Organization[]>
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
  ownOrganizations: async () =>
    database
      .prepare(
        "SELECT * FROM organizations WHERE deleted_at IS NULL AND json_extract(metadata, '$.own') = 1 ORDER BY name, id",
      )
      .all()
      .map(organizationOf),
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
  setOwnOrganization: async (organization, own) =>
    write(database, () => {
      const thing = thingOf(database, organization.includes(":") ? organization : `organization:${organization}`)
      const set =
        own === null
          ? "json_remove(coalesce(metadata, '{}'), '$.own', '$.own_by')"
          : `json_set(coalesce(metadata, '{}'), '$.own', json('${own}'), '$.own_by', 'owner')`
      const row =
        thing?.type === "organization" &&
        database
          .prepare(
            `UPDATE organizations SET metadata = ${set}, updated_at = ? WHERE id = ? AND deleted_at IS NULL RETURNING id, metadata`,
          )
          .get(now(), thing.id)
      if (!row) throw new CliError("not_found", `no organization ${organization}`)
      const metadata = JSON.parse(String(row.metadata ?? "{}")) as { own?: unknown }
      return { ref: `organization:${row.id}`, own: metadata.own === true }
    }),
})
