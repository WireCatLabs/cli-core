import { c, fk, id } from "./columns.mjs"

export const annotationTransferTable = {
  name: "document_annotation_transfers",
  doc: "Completed document annotation copies, scoped to one source file and collection. Reference mappings make a retry safe after the destination committed but the provider checkpoint did not.",
  cols: [
    c("source_key", "text", { notnull: true, note: "SHA256 of the source file identity; no path or credential" }),
    c("collection", "text", { notnull: true, note: "source folder integration's external identity" }),
    c("snapshot_hash", "text", { notnull: true, note: "SHA256 of the exact source graph" }),
    c("bindings_hash", "text", { notnull: true, note: "SHA256 of explicit external reference decisions" }),
    c("reference_map", "text", {
      notnull: true,
      note: "JSON mapping source typed row keys to destination typed row keys",
    }),
    c("created_at", "integer", { notnull: true }),
  ],
  keys: ["PRIMARY KEY (source_key, collection)"],
}

export const documentRevisionsTable = {
  name: "document_revisions",
  doc: "Earlier versions of a document, each kept before a sync or an import replaced or removed it.",
  cols: [
    id(),
    fk("document_id", "documents", { notnull: true }),
    c("body", "text", { notnull: true }),
    c("revision", "integer", { notnull: true }),
    c("created_at", "integer", { notnull: true, note: "when this version was replaced or removed" }),
    c("title", "text", { note: "the title this version had, NULL in a row kept before store version 72" }),
    c("front_matter", "text", { note: "JSON, the front matter this version had" }),
    c("reason", "text", {
      note: "what replaced it: edited, deleted, unavailable (no longer visible to the account) or unsynced (left the synced folders). NULL before store version 72 means edited",
    }),
  ],
}

export const documentChangesTable = {
  name: "document_changes",
  doc: "The change log of synced documents: one row per document a sync or an import added, changed, removed or brought back. It outlives the document row, so it keeps the title and the path. A trigger drops an account's rows with the account.",
  cols: [
    id(),
    c("account_id", "integer", {
      notnull: true,
      note: "the documents account (no foreign key: an older build purging an account does not know this table)",
    }),
    c("document_id", "integer", { notnull: true, note: "no foreign key: the row stays after the document goes" }),
    c("path", "text", { notnull: true, note: "the document's external id, as `documents.external_id`" }),
    c("title", "text"),
    c("event", "text", {
      notnull: true,
      note: "added, changed, deleted, unavailable, unsynced or restored",
    }),
    c("revision", "integer", { notnull: true, note: "the document's revision after the change" }),
    c("at", "integer", { notnull: true }),
  ],
  keys: ["INDEX (account_id, at)"],
}

export const documentHistoryTables = [documentRevisionsTable, documentChangesTable]

export const documentRemoval = () =>
  c("removal", "text", {
    note: "why `deleted_at` is set: deleted at the source, unavailable (no longer visible to the account, its text kept) or unsynced (left the synced folders). NULL while live and for a row removed before store version 72",
  })
