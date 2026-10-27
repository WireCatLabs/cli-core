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
  "assigned-to",
  "attached",
] as const

export type LinkKind = (typeof LINK_KINDS)[number]

/** Where a caller may say a link came from. */
export const LINK_ORIGINS = ["file", "owner", "suggested", "message"] as const

/** Where a stored link came from: an origin a caller gives, or `calendar`, which only the store writes. */
export const LINK_SOURCES = [...LINK_ORIGINS, "calendar"] as const

/** The kinds `knowledge.relate` makes between people, organizations and projects. */
export const RELATION_KINDS = ["member-of", "related-to"] as const satisfies readonly LinkKind[]

/** A kind as an SQL literal, so a kind written into a query is checked against the list. */
export const linkKind = (kind: LinkKind): string => `'${kind}'`
