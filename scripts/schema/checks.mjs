// Store version 73: what every base table with an integer `id` gets in the 1.0 rebuild. Only rules that never change
// go in a CHECK, since changing one takes another rebuild; evolving enums stay in triggers.

const DERIVED =
  /(_fts|_words|_stems|_trigrams|_pending)$|^(embeddings|chunks|chunk_messages|mentions|involvements|search_terms)$|^vector_index/

/** Ids are never handed out twice, so an old `organization:2766` never names another row. */
export const autoIncrements = (table) =>
  !table.virtual &&
  !DERIVED.test(table.name) &&
  (table.cols ?? []).some((col) => col.name === "id" && col.pk && col.type === "integer")

// Noted as JSON but holds plain text the caller encodes.
const NOT_JSON = new Set(["sync_cursors.value"])

// Both halves nullable, and a type with no id means nothing. `links.to` keeps an unresolved target's type.
const HALF_SET_BY_DESIGN = new Set(["links.to"])

// The amounts a validation trigger already refuses below zero.
const AMOUNTS = {
  invoices: ["total"],
  invoice_lines: ["amount", "unit_price"],
  orders: ["total"],
  order_lines: ["amount", "unit_price"],
  deals: ["amount"],
  leads: ["amount"],
  catalog_items: ["unit_price"],
  contracts: ["value"],
  subscription_prices: ["amount"],
}

const jsonColumns = (table) =>
  table.cols.filter((col) => /\bJSON\b/.test(col.note ?? "") && !NOT_JSON.has(`${table.name}.${col.name}`))

const pointerPairs = (table) =>
  table.cols
    .filter((col) => col.name.endsWith("_type"))
    .map((col) => [col, table.cols.find((other) => other.name === col.name.replace(/_type$/, "_id"))])
    // An `_id` with a foreign key is not a pointer: `calendar_entries.event_type` is the entry's kind.
    .filter(([type, id]) => id && !id.ref && !type.notnull && !id.notnull)
    .map(([type]) => type.name.replace(/_type$/, ""))
    .filter((pointer) => !HALF_SET_BY_DESIGN.has(`${table.name}.${pointer}`))

/** `{ name, column(s), sql }` per rule, in a fixed order: JSON columns, pointer pairs, amounts. */
export const checksOf = (table) => {
  if (!autoIncrements(table)) return []
  return [
    ...jsonColumns(table).map((col) => ({
      name: `${table.name}_${col.name}_json`,
      kind: "json",
      columns: [col.name],
      sql: `"${col.name}" IS NULL OR json_valid("${col.name}")`,
    })),
    ...pointerPairs(table).map((pointer) => ({
      name: `${table.name}_${pointer}_pair`,
      kind: "pair",
      columns: [`${pointer}_type`, `${pointer}_id`],
      sql: `("${pointer}_type" IS NULL) = ("${pointer}_id" IS NULL)`,
    })),
    ...(AMOUNTS[table.name] ?? []).map((col) => ({
      name: `${table.name}_${col}_not_negative`,
      kind: "amount",
      columns: [col],
      sql: `"${col}" IS NULL OR "${col}" >= 0`,
    })),
  ]
}
