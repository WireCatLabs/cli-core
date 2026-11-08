import { c, id } from "./columns.mjs"

/** The links a relationship is: its kinds are `RELATIONS` in `src/domain/relations.ts`. */
const RELATIONSHIP_LINKS =
  "kind IN ('member-of', 'related-to', 'reports-to', 'customer-of', 'partner-of') AND to_id IS NOT NULL"

export const RELATIONSHIP_KEY = `UNIQUE (kind, from_type, from_id, to_type, to_id, ifnull(anchor, ''), ifnull(role, ''), ifnull(account_id, 0)) WHERE ${RELATIONSHIP_LINKS}`

/** What store version 56 added to `links`: who reported a relationship, when it held, and whether it still does. */
export const relationshipColumns = [
  [
    "account_id",
    "integer",
    {
      note: "the `accounts` row of the source that reported a relationship, such as a CRM account; null for the owner's and an agent's",
    },
  ],
  ["starts_at", "integer", { note: "when a relationship began, when known; never guessed" }],
  ["ends_at", "integer", { note: "when a relationship ended (exclusive), when known" }],
  ["deleted_at", "integer", { note: "the source stopped reporting the relationship; the row and its history stay" }],
]

export const linkRevisionsTable = {
  name: "link_revisions",
  doc: "One row per change of a relationship link (the kinds of `RELATIONS`: `member-of`, `related-to`, `reports-to`, `customer-of`, `partner-of`). Triggers on `links` write it in the changing statement's transaction, so a hard delete keeps its trail; a change of `updated_at` alone writes none. Links of any other kind never write one. No foreign key: the link may be gone.",
  cols: [
    id(),
    c("link_id", "integer", { notnull: true, note: "the `links` row" }),
    c("change", "text", {
      notnull: true,
      note: "`added`, `changed` (role, dates or account), `ended` (`ends_at` set), `confirmed`, `withdrawn` (`deleted_at` set: the source stopped reporting it), `restored` (reported again), `rejected` (a suggestion the owner rejected) or `removed` (deleted)",
    }),
    c("before", "text", {
      note: "JSON of role, confirmed, account_id, starts_at, ends_at and deleted_at before; null when added",
    }),
    c("after", "text", { note: "the same after; null when removed" }),
    c("author", "text", { note: "the link's `author` after the change, or before a removal" }),
    c("account_id", "integer", { note: "the link's account after the change, or before a removal" }),
    c("created_at", "integer", { notnull: true }),
  ],
  keys: ["INDEX (link_id, created_at)"],
}
