/**
 * Every kind a `links` row may have. The schema doc's description of `links` names exactly these
 * (`schema.test.ts` checks it); a writer that needs a new kind adds it here first.
 */
export const LINK_KINDS = [
  "links-to",
  "blocked-by",
  "follow-up-of",
  "about",
  "member-of",
  "labelled",
  "answered-by",
  "evidence",
  "created-from",
  "duplicate-of",
  "related-to",
  "reports-to",
  "customer-of",
  "partner-of",
  "assigned-to",
  "attached",
] as const

export type LinkKind = (typeof LINK_KINDS)[number]

/** Where a caller may say a link came from. */
export const LINK_ORIGINS = ["file", "owner", "suggested", "message"] as const

/** Where a stored link came from: an origin a caller gives, or `calendar`, which only the store writes. */
export const LINK_SOURCES = [...LINK_ORIGINS, "calendar"] as const

export { RELATION_KINDS } from "../../domain/relations.js"

/** A kind as an SQL literal, so a kind written into a query is checked against the list. */
export const linkKind = (kind: LinkKind): string => `'${kind}'`

/** The `role` of the `related-to` link from a phone call's event to the person on the other end. */
export const COUNTERPART_ROLE = "counterpart"
export { REPORTER_SQL } from "./link-source.js"
