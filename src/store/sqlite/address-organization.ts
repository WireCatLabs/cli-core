import { CliError } from "@wirecat/cli-base"
import { FREE_MAIL } from "../../mail/score.js"
import { fold } from "../normalize.js"
import type { StoreContext } from "./open.js"

const BY_ADDRESS =
  "SELECT DISTINCT o.id FROM organizations o JOIN organization_identities oi ON oi.organization_id = o.id " +
  "JOIN identities i ON i.id = oi.identity_id WHERE o.deleted_at IS NULL AND i.provider = 'email' AND "

const idsOf = (rows: Record<string, unknown>[]): number[] => rows.map((row) => Number(row.id))

/** Gives the address to the organization, making its `email` identity when the store has none. */
export const holdAddress = (
  { database, now }: StoreContext,
  organization: number,
  email: string,
  { method, author }: { method: string; author: string },
): void => {
  const at = now()
  database
    .prepare(
      "INSERT INTO identities (provider, external_id, created_at, updated_at) VALUES ('email', ?, ?, ?) " +
        "ON CONFLICT (provider, external_id) DO NOTHING",
    )
    .run(email, at, at)
  database
    .prepare(
      "INSERT INTO organization_identities (identity_id, organization_id, method, author, created_at, updated_at) " +
        "SELECT id, ?, ?, ?, ?, ? FROM identities WHERE provider = 'email' AND external_id = ? " +
        "ON CONFLICT (identity_id, organization_id) DO NOTHING",
    )
    .run(organization, method, author, at, at, email)
}

/**
 * The organization an address belongs to: the one holding the address, else the one holding its company domain, else
 * the one of exactly this name; else a new company of this name. The address joins it, so the next lookup finds it.
 * More than one match is refused with `reason`, for the caller to name the one meant.
 */
export const organizationOfAddress = (
  context: StoreContext,
  {
    name,
    email,
    method,
    author,
    reason,
  }: { name: string; email?: string; method: string; author: string; reason: string },
): number => {
  const { database, now } = context
  const domain = email?.split("@")[1]
  let found = email === undefined ? [] : idsOf(database.prepare(`${BY_ADDRESS}lower(i.external_id) = ?`).all(email))
  if (!found.length && domain && !FREE_MAIL.has(domain))
    found = idsOf(
      database.prepare(`${BY_ADDRESS}substr(lower(i.external_id), -length(?)) = ?`).all(`@${domain}`, `@${domain}`),
    )
  if (!found.length)
    found = database
      .prepare("SELECT id, name FROM organizations WHERE deleted_at IS NULL")
      .all()
      .filter((row) => fold(String(row.name)).trim() === fold(name).trim())
      .map((row) => Number(row.id))
  if (found.length > 1)
    throw new CliError(
      "validation_error",
      `${found.length} organizations match ${name} (${found.map((id) => `organization:${id}`).join(", ")}); ` +
        "name the one meant as a reference",
      { reason },
    )
  const at = now()
  const id =
    found[0] ??
    Number(
      database
        .prepare(
          "INSERT INTO organizations (kind, name, scope, created_at, updated_at) VALUES ('company', ?, 'work', ?, ?) RETURNING id",
        )
        .get(name, at, at)?.id,
    )
  if (email !== undefined) holdAddress(context, id, email, { method, author })
  return id
}
