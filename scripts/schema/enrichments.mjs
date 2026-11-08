import { c } from "./columns.mjs"

export const enrichmentTables = [
  {
    name: "enrichments",
    doc: "What a hosted model wrote about one note, document or email when the owner turned enrichment on: standalone facts and questions in other words. Search reads it beside the record, so a hit still cites the record. Written only with the owner's consent; deleted with the record, and all of it when enrichment is turned off.",
    cols: [
      c("subject_type", "text", { notnull: true, note: "`document`, `note` or `email`" }),
      c("subject_id", "integer", { notnull: true, note: "the row of that table" }),
      c("source_hash", "text", {
        notnull: true,
        note: "hash of the record's indexed text the model read; a record whose text changed is enriched again",
      }),
      c("provider", "text", { notnull: true, note: "`openai` or `anthropic`" }),
      c("model", "text", { notnull: true, note: "the provider's model name" }),
      c("text", "text", { notnull: true, note: "the facts and questions, one a line" }),
      c("tokens", "integer", { notnull: true, note: "this record's share of the provider's reported tokens" }),
      c("created_at", "integer", { notnull: true }),
    ],
    keys: ["PRIMARY KEY (subject_type, subject_id)"],
  },
]
