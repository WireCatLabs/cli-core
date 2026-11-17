import { c, fk, fts, id } from "./columns.mjs"

export const trackerTables = [
  {
    name: "tracker_items",
    doc: "One team, user, workflow state, label, project, issue or comment of an issue tracker account (Linear), as last synced. The columns are what lists, filters and search read; the rest of the record is `data`.",
    cols: [
      id(),
      fk("account_id", "accounts", { notnull: true, note: "the tracker account it was copied from" }),
      c("kind", "text", { notnull: true, note: "team, user, state, label, project, issue or comment" }),
      c("external_id", "text", { notnull: true, note: "its id in the tracker" }),
      c("parent_id", "text", {
        note: "the tracker's id of what it hangs under: a comment's issue, an issue's, a state's or a label's team",
      }),
      c("title", "text", { notnull: true, note: "an issue's title, a comment's first line, anything else's name" }),
      c("title_folded", "text", { notnull: true, note: "the title in one letter case" }),
      c("body", "text", { note: "an issue's or a project's description, a comment's text" }),
      c("normalized_text", "text", { notnull: true, note: "title and body normalized for the word index" }),
      c("data", "text", {
        notnull: true,
        note: "JSON: the record in the tracker domain's field names; a field the tracker did not send keeps its stored value",
      }),
      c("source_created_at", "integer", { note: "when the tracker says it was made" }),
      c("source_updated_at", "integer", { note: "when the tracker says it last changed" }),
      c("archived_at", "integer", { note: "the tracker archived it; it still exists there" }),
      c("deleted_at", "integer", { note: "the tracker no longer lists it; sync never hard-deletes" }),
      c("synced_at", "integer", { notnull: true }),
    ],
    keys: ["UNIQUE (account_id, kind, external_id)", "INDEX (account_id, kind, parent_id)"],
  },
  fts(
    "tracker_item_words",
    "Word index over a tracker item's title and text, rowid = `tracker_items.id`.",
    "normalized_text",
  ),
]
