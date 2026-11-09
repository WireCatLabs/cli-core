import { CliError } from "@wirecat/cli-base"
import { CATEGORIES, type Category } from "../../domain/categories.js"
import { usableLinkSql } from "../../domain/relations.js"
import type { AccountKey } from "../types.js"
import { linkKind } from "./link-kinds.js"

/** Which organizations `organizations` answers: those of one category, read from relationships in `accounts` only. */
export interface OrganizationFilter {
  category?: Category
  /** Relationships a source account reported count only from these; the owner's always count. Every one when absent. */
  accounts?: AccountKey[]
}

const OWN = "(SELECT id FROM organizations WHERE deleted_at IS NULL AND json_extract(metadata, '$.own') = 1)"
const EMPLOYED = "('employee', 'contractor', 'founder')"

/**
 * The category as SQL over `organizations o`, derived from usable relationships at `now` (NEED-2377), as
 * `organizationCategories` derives it: `client` is `customer-of` an own organization, `supplier` one an own
 * organization is `customer-of`, `partner` `partner-of` one, `employer` one the owner's person is `member-of` as
 * employee, contractor or founder.
 */
export const categorySql = (
  { category, accounts }: OrganizationFilter,
  now: number,
): { sql: string; params: string[] } | undefined => {
  if (category === undefined) return undefined
  if (!CATEGORIES.includes(category))
    throw new CliError("validation_error", `a category is one of ${CATEGORIES.join(", ")}`)
  const keys = accounts?.map(({ provider, account }) => `${provider}:${account}`) ?? []
  const reporter =
    accounts === undefined
      ? ""
      : ` AND (l.account_id IS NULL OR l.account_id IN (SELECT id FROM accounts WHERE provider || ':' || external_id ` +
        `IN (${keys.map(() => "?").join(", ") || "NULL"})))`
  const usable = `${usableLinkSql("l", now)}${reporter}`
  const org = (end: "from" | "to") => `l.${end}_type = 'organization'`
  const where = {
    client: `l.kind = ${linkKind("customer-of")} AND ${org("from")} AND l.from_id = o.id AND ${org("to")} AND l.to_id IN ${OWN}`,
    supplier: `l.kind = ${linkKind("customer-of")} AND ${org("from")} AND l.from_id IN ${OWN} AND ${org("to")} AND l.to_id = o.id`,
    partner:
      `l.kind = ${linkKind("partner-of")} AND ${org("from")} AND ${org("to")} AND ` +
      `((l.from_id = o.id AND l.to_id IN ${OWN}) OR (l.to_id = o.id AND l.from_id IN ${OWN}))`,
    employer:
      `l.kind = ${linkKind("member-of")} AND l.from_type = 'person' AND l.from_id IN (SELECT id FROM persons WHERE ` +
      `owner = 1) AND ${org("to")} AND l.to_id = o.id AND l.role IN ${EMPLOYED}`,
  }[category]
  return { sql: `EXISTS (SELECT 1 FROM links l WHERE ${where} AND ${usable})`, params: keys }
}
