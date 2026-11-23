import { CliError } from "@wirecat/cli-base"
import type { Decider } from "../decisions.js"
import type { CacheDatabase } from "../driver.js"
import { ErasePlan } from "./erase-plan.js"
import { forgetDanglingEvidence } from "./evidence-signature.js"
import type { StoreContext } from "./open.js"
import { ownerOnly } from "./person-merges.js"

export interface OrganizationErasure {
  organization: string
  name: string
  /** `false`: what `erase` would do, nothing changed. */
  erased: boolean
  /** Identities the organization held, such as its domain; the identities stay, the holding goes. */
  identities: string[]
  /** Rows that only tied something to the organization, such as a tag, a link or a mention, by `table.column`. */
  deleted: Record<string, number>
  /** Rows that stay and lose the organization, such as a deal, a lead, a project or an account. */
  detached: Record<string, number>
}

const OWN_ROWS = new Set(["organization_identities"])

const organizationOf = (database: CacheDatabase, ref: string) => {
  const asked = /^(?:organization:)?([1-9]\d*)$/u.exec(ref.trim())?.[1]
  const row =
    asked === undefined
      ? undefined
      : database.prepare("SELECT id, name, metadata FROM organizations WHERE id = ?").get(Number(asked))
  if (row === undefined)
    throw new CliError("not_found", `the store has no organization for "${ref}"`, { reason: "organization.not-found" })
  return {
    id: Number(row.id),
    name: String(row.name),
    own: [true, 1].includes(JSON.parse(String(row.metadata ?? "{}"))?.own),
  }
}

/**
 * Deletes an organization and what memo knows of it alone: the tags, links, aliases and mentions that name it, and
 * which identities it held, and the owner's notes about it. A deal, lead, project, account or fact that names it stays
 * and loses the name.
 * Refused for one of the owner's own companies, and while an invoice, order, subscription or a row it wrote cannot
 * be without it. `apply: false` answers the same without changing anything.
 */
export const eraseOrganization = (
  context: StoreContext,
  ref: string,
  by: Decider,
  apply: boolean,
): OrganizationErasure => {
  ownerOnly(by, "deletes an organization")
  const { database } = context
  const organization = organizationOf(database, ref)
  if (organization.own)
    throw new CliError("validation_error", `organization:${organization.id} is one of your own companies`, {
      reason: "organization.own",
    })
  const identities = database
    .prepare(
      `SELECT i.provider || ':' || i.external_id AS ref FROM organization_identities o
        JOIN identities i ON i.id = o.identity_id WHERE o.organization_id = ? ORDER BY i.id`,
    )
    .all(organization.id)
    .map((one) => String(one.ref))
  const plan = new ErasePlan(database)
    .pointers("organization", "?", [organization.id])
    .foreignKeys("organizations", organization.id, OWN_ROWS)
  if (plan.blocked.length > 0)
    throw new CliError(
      "validation_error",
      `organization:${organization.id} is still named by ${plan.blocked.join(", ")}; change those first — nothing ` +
        "was deleted",
      { reason: "organization.erase-blocked", blocked: plan.blocked },
    )
  const answer = (erased: boolean): OrganizationErasure => ({
    organization: `organization:${organization.id}`,
    name: organization.name,
    erased,
    identities,
    deleted: plan.deleted,
    detached: plan.detached,
  })
  if (!apply) return answer(false)
  plan.run()
  database.prepare("DELETE FROM organization_identities WHERE organization_id = ?").run(organization.id)
  database.prepare("DELETE FROM organizations WHERE id = ?").run(organization.id)
  forgetDanglingEvidence(database, context.now())
  return answer(true)
}

/** The organizations an account's records made: read before a purge deletes the records. */
export const importedOrganizations = (database: CacheDatabase, accountKey: number): number[] =>
  database
    .prepare("SELECT DISTINCT entity_id AS id FROM records WHERE account_id = ? AND entity_type = 'organization'")
    .all(accountKey)
    .map(({ id }) => Number(id))

/**
 * After a purge, the organizations only its records made go too: no other row names them. One the owner tagged,
 * linked, gave a deal to or calls his own stays.
 */
export const eraseImportedOrganizations = (context: StoreContext, organizations: readonly number[]): void => {
  for (const id of organizations) {
    if (context.database.prepare("SELECT 1 FROM organizations WHERE id = ?").get(id) === undefined) continue
    try {
      const plan = eraseOrganization(context, String(id), "owner", false)
      if (Object.keys(plan.deleted).length === 0 && Object.keys(plan.detached).length === 0)
        eraseOrganization(context, String(id), "owner", true)
    } catch (error) {
      if (!(error instanceof CliError)) throw error
    }
  }
}
