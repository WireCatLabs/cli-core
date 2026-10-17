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
  doc: "Earlier bodies of a document.",
  cols: [
    id(),
    fk("document_id", "documents", { notnull: true }),
    c("body", "text", { notnull: true }),
    c("revision", "integer", { notnull: true }),
    c("created_at", "integer", { notnull: true }),
  ],
}
