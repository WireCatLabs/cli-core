import { CliError } from "@wirecat/cli-base"
import { DEAL_ROLES } from "./deals.js"

/** What a person is to an organization; who reports to whom is `reports-to`, and a job title is never a role. */
export const ORGANIZATION_ROLES = [
  "employee",
  "contractor",
  "founder",
  "owner",
  "manager",
  "adviser",
  "contact",
] as const
export const PROJECT_ROLES = ["owner", "manager", "contributor", "client-contact", "approver"] as const
/** A contract party's part; a party the list cannot name has none, never a catch-all `other`. */
export const CONTRACT_ROLES = ["customer", "supplier", "signatory", "guarantor"] as const

/** How much the owner deals with a person on a project himself, not how active the person is; absent is unknown. */
export const ENGAGEMENT_LEVELS = ["none", "low", "medium", "high"] as const
export type Engagement = (typeof ENGAGEMENT_LEVELS)[number]

export const isEngagement = (value: unknown): value is Engagement =>
  typeof value === "string" && (ENGAGEMENT_LEVELS as readonly string[]).includes(value)

/** Only a person's membership of a project takes an engagement level. */
export const checkEngagement = (kind: string, from: string, to: string, level: string): Engagement => {
  if (kind !== "member-of" || from !== "person" || to !== "project")
    throw new CliError("validation_error", "an engagement level is set only on a person's member-of a project", {
      reason: "relationship.engagement-ends",
    })
  if (!isEngagement(level))
    throw new CliError("validation_error", `an engagement level is one of ${ENGAGEMENT_LEVELS.join(", ")}`, {
      reason: "relationship.engagement-unknown",
    })
  return level
}

/** Who the owner deals with most comes first: high, medium, unknown, low, none. */
const ENGAGEMENT_ORDER: Record<Engagement | "unknown", number> = { high: 0, medium: 1, unknown: 2, low: 3, none: 4 }

export const engagementRank = (level: Engagement | null | undefined): number => ENGAGEMENT_ORDER[level ?? "unknown"]

/** A stable sort by `engagementRank`; links without a level keep their order among themselves. */
export const byEngagement = <T extends { engagement?: Engagement | null }>(items: readonly T[]): T[] =>
  items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => engagementRank(a.item.engagement) - engagementRank(b.item.engagement) || a.index - b.index)
    .map(({ item }) => item)

type End = "person" | "organization" | "project" | "task" | "chat" | "email_thread" | "deal" | "lead" | "contract"

interface RelationSpec {
  from: readonly End[]
  to: readonly End[]
  /** Role lists by the end that names them; where none applies, a role is free text. */
  roles?: { from?: Partial<Record<End, readonly string[]>>; to?: Partial<Record<End, readonly string[]>> }
  /** Shown when a relationship is read from its `to` end; never stored. */
  inverse?: string
  /** Stored once, the lower id as `from`. */
  symmetric?: true
}

/**
 * Every relationship `knowledge.relate` makes, its ends, its roles and how it reads backwards. An organization may
 * still be a member: owner data from before this list holds such links.
 */
export const RELATIONS = {
  "member-of": {
    from: ["person", "organization", "project", "chat", "email_thread"],
    to: ["organization", "project"],
    roles: { to: { organization: ORGANIZATION_ROLES, project: PROJECT_ROLES } },
  },
  "reports-to": { from: ["person"], to: ["person"], inverse: "manages" },
  "customer-of": { from: ["person", "organization"], to: ["organization"], inverse: "supplier of" },
  "partner-of": { from: ["organization"], to: ["organization"], symmetric: true },
  "related-to": {
    from: ["person", "organization", "project", "task", "deal", "lead", "contract"],
    to: ["person", "organization", "project", "task"],
    roles: { from: { deal: DEAL_ROLES, lead: DEAL_ROLES, contract: CONTRACT_ROLES } },
  },
} as const satisfies Record<string, RelationSpec>

export type RelationKind = keyof typeof RELATIONS
export const RELATION_KINDS = Object.keys(RELATIONS) as RelationKind[]

const specOf = (kind: string): RelationSpec | undefined =>
  Object.hasOwn(RELATIONS, kind) ? (RELATIONS as Record<string, RelationSpec>)[kind] : undefined

export const isRelationKind = (kind: string): kind is RelationKind => specOf(kind) !== undefined

/** A chat or a mail thread is only ever a project's member: its reference names one account. */
const memberOnly = (type: string) => type === "chat" || type === "email_thread"

/** A contract's parties are the people and organizations that signed it. */
const partyOnly = (from: string, to: string) => from === "contract" && to !== "person" && to !== "organization"

export const checkEnds = (kind: string, from: string, to: string): RelationSpec => {
  const spec = specOf(kind)
  if (!spec) throw new CliError("validation_error", `a relationship's kind is one of ${RELATION_KINDS.join(", ")}`)
  if (memberOnly(from) && (kind !== "member-of" || to !== "project"))
    throw new CliError(
      "validation_error",
      `a ${from === "chat" ? "chat" : "mail thread"} is related only as member-of a project`,
    )
  if (partyOnly(from, to))
    throw new CliError("validation_error", "a contract is related only to a person or an organization")
  if (!spec.from.includes(from as End) || !spec.to.includes(to as End))
    throw new CliError(
      "validation_error",
      `${kind} joins ${spec.from.join(", ")} to ${spec.to.join(", ")}, not ${from} to ${to}`,
    )
  return spec
}

/**
 * The roles a relationship takes, or `undefined` for free text. A member's list is the organization's or the
 * project's only when the member is a person: a chat's or a sub-project's role was never one of them.
 */
export const rolesOf = (kind: string, from: string, to: string): readonly string[] | undefined => {
  const spec = specOf(kind)
  if (kind === "member-of" && from !== "person") return undefined
  return spec?.roles?.from?.[from as End] ?? spec?.roles?.to?.[to as End]
}

/** The role lists the owner may add to; each is a list the registry gives some relationship's ends. */
export const ROLE_LISTS = {
  organization: ORGANIZATION_ROLES,
  project: PROJECT_ROLES,
  deal: DEAL_ROLES,
  contract: CONTRACT_ROLES,
} as const
export type RoleList = keyof typeof ROLE_LISTS

/** Which list a relationship's role comes from, or `undefined` where a role is free text. */
export const roleListOf = (kind: string, from: string, to: string): RoleList | undefined => {
  const roles = rolesOf(kind, from, to)
  return (Object.keys(ROLE_LISTS) as RoleList[]).find((list) => ROLE_LISTS[list] === roles)
}

/**
 * The role as given when the relationship has no list, or when it is on the list or among `extra` (the owner's own
 * roles for that list); refused otherwise.
 */
export const checkRole = (
  kind: string,
  from: string,
  to: string,
  role: string,
  extra: readonly string[] = [],
): string => {
  const roles = rolesOf(kind, from, to)?.concat(extra)
  if (roles && !roles.includes(role))
    throw new CliError("validation_error", `a ${from}'s role on ${kind} ${to} is one of ${roles.join(", ")}`, {
      reason: "relationship.role-unknown",
    })
  return role
}

export const isSymmetric = (kind: string): boolean => specOf(kind)?.symmetric === true

/** The label of a relationship read from its `to` end: `manages` for `reports-to`; the kind itself when symmetric. */
export const inverseOf = (kind: string): string | null =>
  specOf(kind)?.symmetric ? kind : ((specOf(kind)?.inverse as string | undefined) ?? null)

/**
 * What an answer says about a relationship, derived, never stored: the owner's, a source's that nobody confirmed, an
 * agent's suggestion waiting for review, or one that no longer holds.
 */
export const STANDINGS = ["confirmed", "reported", "proposed", "ended"] as const
export type Standing = (typeof STANDINGS)[number]

/** A link's columns `standing` reads; a column an older store lacks is `null`. */
export interface StandingFields {
  confirmed: boolean
  accountId?: number | null
  /** Epoch ms, exclusive. */
  endsAt?: number | null
  deletedAt?: number | null
}

/** What a `links` row of a relationship kind holds beyond any link, when set. */
export interface RelationshipColumns {
  /** The `accounts` row of the source that reported it. */
  accountId?: number
  /** When it held, epoch ms; `endsAt` exclusive. */
  startsAt?: number
  endsAt?: number
  /** The source stopped reporting it. */
  deletedAt?: number
  /** A job title beside it (`metadata.position`), never its role. */
  position?: string
  /** What the role means here, in the owner's words, beside a role from a list (`metadata.roleNote`). */
  roleNote?: string
  /** A person's on a project (`metadata.engagement`). */
  engagement?: Engagement
  /** The source's link this owner link overrides (`metadata.overrides`). */
  overrides?: number
  /** The source's own words for it, off the role list (`metadata.source_role`), never its role. */
  sourceRoles?: string[]
  /** The source account that reported it, `<provider>:<account>`. */
  account?: string
  /** How a source made the relationship when it stated none, such as `department-head`. */
  derived?: string
}

/** The owner's confirmation outlives a source that stopped reporting it; only its own end date ends it. */
export const standingOf = (link: StandingFields, now: number): Standing => {
  if (link.endsAt != null && link.endsAt <= now) return "ended"
  if (link.confirmed) return "confirmed"
  if (link.deletedAt != null) return "ended"
  return link.accountId != null ? "reported" : "proposed"
}

/** A relationship a context or a traversal counts: the owner's, or a source's that still holds. */
export const isUsable = (standing: Standing): boolean => standing === "confirmed" || standing === "reported"

export const usableLink = (link: StandingFields, now: number): boolean => isUsable(standingOf(link, now))

// links_relationship_key's WHERE, word for word: without it SQLite cannot use that partial index, picks
// (to_type, to_id) and reads every link of a busy end, such as a deal owner's, for each relationship (#2623).
export const KEYED =
  "kind IN ('member-of', 'related-to', 'reports-to', 'customer-of', 'partner-of') AND to_id IS NOT NULL"

/**
 * The `links` row aliased `alias` has no owner link overriding it (`metadata.overrides`, an owner's edit of a link a
 * source reported): where one does, the override is the answer.
 */
export const notOverriddenSql = (alias: string): string =>
  `NOT EXISTS (SELECT 1 FROM links override WHERE ${KEYED} AND override.kind = ${alias}.kind ` +
  `AND override.from_type = ${alias}.from_type ` +
  `AND override.from_id = ${alias}.from_id AND override.to_type = ${alias}.to_type AND override.to_id = ${alias}.to_id ` +
  `AND json_extract(override.metadata, '$.overrides') = ${alias}.id)`

/** `usableLink` as SQL over the `links` row aliased `alias`; without `now` an end date is not checked. */
export const usableLinkSql = (alias: string, now?: number): string =>
  `(${alias}.confirmed = 1 OR (${alias}.account_id IS NOT NULL AND ${alias}.deleted_at IS NULL))` +
  (now === undefined ? "" : ` AND (${alias}.ends_at IS NULL OR ${alias}.ends_at > ${Math.trunc(now)})`)
