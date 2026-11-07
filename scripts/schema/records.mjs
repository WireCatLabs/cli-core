import { c, del, fk, id, ts } from "./columns.mjs"

export const recordTables = [
  {
    name: "records",
    doc: "What a source said about one of its records (a payment row of a sheet, a deal of a CRM), kept as it said it. An import upserts it by the source's identity; a typed entity made from it is a proposal the owner confirms.",
    cols: [
      id(),
      fk("account_id", "accounts", { notnull: true }),
      c("type", "text", {
        notnull: true,
        note: "invoice, payment, person, organization, project, or custom:<name> for a type without a table",
      }),
      c("external_id", "text", { notnull: true, note: "the record's id at the source" }),
      c("fields", "text", { notnull: true, note: "JSON: what the source sends, untrusted data; never a secret" }),
      c("revision", "integer", { note: "the source's revision; a lower one is refused as stale" }),
      c("fingerprint", "text", {
        notnull: true,
        note: "SHA-256 of the fields and relations: the same import twice changes nothing",
      }),
      c("entity_type", "text", { note: "the entity made from it or mapped to it by the owner; never matched by name" }),
      c("entity_id", "integer"),
      c("projected_fingerprint", "text", {
        note: "the fingerprint the entity was made from: when it differs, the source changed after and the entity is flagged",
      }),
      c("batch_id", "text", { notnull: true, note: "the import that wrote it last" }),
      ...ts(),
      del(),
      c("created_entity", "integer", {
        notnull: true,
        note: "1 when this record created its entity: made by the import",
      }),
    ],
    keys: ["UNIQUE (account_id, type, external_id)", "INDEX (account_id, batch_id)"],
  },
  {
    name: "record_relations",
    doc: "A record's reference to another record of the same account. A target not yet imported stays unresolved until it arrives.",
    cols: [
      id(),
      fk("record_id", "records", { notnull: true }),
      c("role", "text", { notnull: true, note: "what the target is to the record: counterparty, payer, settles, …" }),
      c("target_type", "text", { notnull: true }),
      c("target_external_id", "text", { notnull: true }),
      fk("target_id", "records", { note: "null until the target is imported" }),
      c("created_at", "integer", { notnull: true }),
      c("amount", "text", {
        note: "the share of a payment a settles relation names, a decimal in its currency; null: as far as both allow",
      }),
      c("as_role", "text", { note: "the role inside a relationship, such as decision-maker or customer" }),
    ],
    keys: ["UNIQUE (record_id, role, target_type, target_external_id)", "INDEX (target_type, target_external_id)"],
  },
]
