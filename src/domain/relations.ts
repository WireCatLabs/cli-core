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

type End = "person" | "organization" | "project" | "task" | "chat" | "email_thread" | "deal" | "lead"

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
    from: ["person", "organization", "project", "task", "deal", "lead"],
    to: ["person", "organization", "project", "task"],
    roles: { from: { deal: DEAL_ROLES, lead: DEAL_ROLES } },
  },
} as const satisfies Record<string, RelationSpec>

export type RelationKind = keyof typeof RELATIONS
export const RELATION_KINDS = Object.keys(RELATIONS) as RelationKind[]

const specOf = (kind: string): RelationSpec | undefined =>
  Object.hasOwn(RELATIONS, kind) ? (RELATIONS as Record<string, RelationSpec>)[kind] : undefined

export const isRelationKind = (kind: string): kind is RelationKind => specOf(kind) !== undefined

/** A chat or a mail thread is only ever a project's member: its reference names one account. */
const memberOnly = (type: string) => type === "chat" || type === "email_thread"

export const checkEnds = (kind: string, from: string, to: string): RelationSpec => {
  const spec = specOf(kind)
  if (!spec) throw new CliError("validation_error", `a relationship's kind is one of ${RELATION_KINDS.join(", ")}`)
  if (memberOnly(from) && (kind !== "member-of" || to !== "project"))
    throw new CliError(
      "validation_error",
      `a ${from === "chat" ? "chat" : "mail thread"} is related only as member-of a project`,
    )
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
export const ROLE_LISTS = { organization: ORGANIZATION_ROLES, project: PROJECT_ROLES, deal: DEAL_ROLES } as const
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

/** `usableLink` as SQL over the `links` row aliased `alias`; without `now` an end date is not checked. */
export const usableLinkSql = (alias: string, now?: number): string =>
  `(${alias}.confirmed = 1 OR (${alias}.account_id IS NOT NULL AND ${alias}.deleted_at IS NULL))` +
  (now === undefined ? "" : ` AND (${alias}.ends_at IS NULL OR ${alias}.ends_at > ${Math.trunc(now)})`)
