// Column and table builders the schema spec is written with.
export const c = (name, type, o = {}) => ({ name, type, ...o })
export const id = () => c("id", "integer", { pk: true })
export const ts = () => [c("created_at", "integer", { notnull: true }), c("updated_at", "integer", { notnull: true })]
export const del = () => c("deleted_at", "integer", { note: "gone at the source; sync never hard-deletes" })
export const meta = () =>
  c("metadata", "text", { note: "JSON: what the source sends that has no column, and is not searched" })
export const fk = (name, table, o = {}) => c(name, "integer", { ref: `${table}.id`, ...o })
export const poly = (name, note) => [
  c(`${name}_type`, "text", { notnull: true, note }),
  c(`${name}_id`, "integer", { notnull: true }),
]
export const actor = (name, o = {}) => [
  c(`${name}_type`, "text", { note: "`person` or `bot`", ...o }),
  c(`${name}_id`, "integer", o),
]
export const fts = (name, doc, cols) => {
  const words = name.endsWith("_words")
  const sql = `CREATE VIRTUAL TABLE ${name} USING fts5(${cols}, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2'${words ? ", prefix = '3'" : ""})`
  return {
    name,
    virtual: true,
    doc,
    sql: words ? `${sql};\nCREATE VIRTUAL TABLE ${name}_vocab USING fts5vocab(${name}, 'col')` : sql,
  }
}
export const queue = (name, of) => ({
  name,
  doc: `Rows of ${of} waiting to be indexed: triggers enqueue, JS normalizes, stems and writes the index.`,
  cols: [c("id", "integer", { notnull: true }), c("indexable_type", "text", { notnull: true })],
  keys: ["PRIMARY KEY (indexable_type, id)"],
})
