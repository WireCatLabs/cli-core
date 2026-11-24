// Store version 73: what every base table with an integer `id` gets in the 1.0 rebuild. Only rules that never change
// go in a CHECK, since changing one takes another rebuild; evolving enums stay in triggers.

const DERIVED =
  /(_fts|_words|_stems|_trigrams|_pending)$|^(embeddings|chunks|chunk_messages|mentions|involvements|search_terms)$|^vector_index/

/** Ids are never handed out twice, so an old `organization:2766` never names another row. */
export const autoIncrements = (table) =>
  !table.virtual &&
  !DERIVED.test(table.name) &&
  (table.cols ?? []).some((col) => col.name === "id" && col.pk && col.type === "integer")

/**
 * Frozen at version 73: JSON columns, pointer pairs (`<name>_type` and `<name>_id`, whole or empty) and amounts a
 * validation trigger already keeps non-negative. SQLite cannot add a table CHECK in place, so a column added later
 * gets a `RAISE(ABORT)` trigger instead; a new table lists its own here when it is created.
 */
const CHECKS = {
  accounts: {
    json: ["settings"],
  },
  bot_updates: {
    json: ["payload"],
  },
  syncs: {
    json: ["counts"],
  },
  identities: {
    json: ["metadata"],
  },
  identity_revisions: {
    json: ["marks"],
  },
  organizations: {
    json: ["metadata"],
  },
  bots: {
    json: ["metadata"],
  },
  chats: {
    json: ["metadata"],
  },
  messages: {
    json: ["reply_to", "forward", "reactions", "metadata", "mentions"],
  },
  poll_votes: {
    json: ["answers"],
  },
  link_revisions: {
    json: ["before"],
  },
  email_threads: {
    json: ["metadata"],
  },
  emails: {
    json: ["references", "headers", "metadata"],
  },
  mail_rules: {
    json: ["conditions", "actions"],
  },
  attachments: {
    json: ["provider_ref", "contact"],
  },
  documents: {
    json: ["front_matter", "metadata"],
  },
  files: {
    json: ["metadata"],
  },
  document_revisions: {
    json: ["front_matter"],
  },
  notes: {
    pairs: ["author"],
  },
  memories: {
    pairs: ["subject"],
  },
  calendar_entries: {
    json: ["recurrence", "metadata"],
  },
  meeting_series: {
    json: ["recurrence", "metadata"],
  },
  meetings: {
    json: ["metadata"],
  },
  meeting_participants: {
    json: ["sessions", "metadata"],
  },
  meeting_transcripts: {
    json: ["metadata"],
  },
  meeting_transcript_rows: {
    json: ["metadata"],
  },
  meeting_chat_messages: {
    json: ["metadata"],
  },
  meeting_summaries: {
    json: ["sections", "next_steps", "metadata"],
  },
  projects: {
    pairs: ["owner"],
  },
  tasks: {
    json: ["metadata"],
    pairs: ["closed_by", "close_suggested_by"],
  },
  task_events: {
    json: ["changes"],
    pairs: ["actor"],
  },
  task_pairs: {
    json: ["levels", "reasons"],
    pairs: ["decided_by"],
  },
  decisions: {
    json: ["metadata"],
    pairs: ["confirmed_by"],
  },
  facts: {
    json: ["metadata"],
    pairs: ["subject", "confirmed_by"],
  },
  invoices: {
    json: ["metadata"],
    pairs: ["issuer", "confirmed_by"],
    amounts: ["total"],
  },
  invoice_lines: {
    amounts: ["amount", "unit_price"],
  },
  payments: {
    json: ["metadata"],
    pairs: ["payer", "payee", "confirmed_by"],
  },
  orders: {
    json: ["metadata"],
    pairs: ["supplier", "confirmed_by"],
    amounts: ["total"],
  },
  deals: {
    json: ["metadata"],
    amounts: ["amount"],
  },
  leads: {
    json: ["metadata"],
    amounts: ["amount"],
  },
  crm_fields: {
    json: ["options"],
  },
  catalog_items: {
    json: ["metadata"],
    pairs: ["supplier"],
    amounts: ["unit_price"],
  },
  order_lines: {
    amounts: ["amount", "unit_price"],
  },
  contracts: {
    json: ["metadata"],
    pairs: ["confirmed_by"],
    amounts: ["value"],
  },
  subscriptions: {
    json: ["metadata"],
    pairs: ["confirmed_by"],
  },
  subscription_prices: {
    json: ["metadata"],
    pairs: ["confirmed_by"],
    amounts: ["amount"],
  },
  financial_accounts: {
    json: ["metadata"],
    pairs: ["holder"],
  },
  financial_transactions: {
    json: ["metadata"],
    pairs: ["counterparty", "confirmed_by"],
  },
  records: {
    json: ["fields"],
    pairs: ["entity"],
  },
  proposed_actions: {
    json: ["payload", "result"],
    pairs: ["target", "decided_by"],
  },
  agent_actions: {
    pairs: ["target"],
  },
  links: {
    json: ["metadata"],
  },
  searches: {
    json: ["params"],
  },
  taggings: {
    pairs: ["author"],
  },
  tag_consolidations: {
    json: ["source_member_ids", "survivor_member_ids", "counts"],
  },
  link_reviews: {
    json: ["candidates"],
  },
  tracker_items: {
    json: ["data"],
  },
  content_authors: {
    json: ["data"],
  },
  content_terms: {
    json: ["data"],
  },
  content_posts: {
    json: ["data"],
  },
  content_metrics: {
    json: ["raw"],
  },
}

/** `{ name, kind, columns, sql }` per rule, in a fixed order: JSON columns, pointer pairs, amounts. */
export const checksOf = (table) => {
  const { json = [], pairs = [], amounts = [] } = CHECKS[table.name] ?? {}
  return [
    ...json.map((col) => ({
      name: `${table.name}_${col}_json`,
      kind: "json",
      columns: [col],
      sql: `"${col}" IS NULL OR json_valid("${col}")`,
    })),
    ...pairs.map((pointer) => ({
      name: `${table.name}_${pointer}_pair`,
      kind: "pair",
      columns: [`${pointer}_type`, `${pointer}_id`],
      sql: `("${pointer}_type" IS NULL) = ("${pointer}_id" IS NULL)`,
    })),
    ...amounts.map((col) => ({
      name: `${table.name}_${col}_not_negative`,
      kind: "amount",
      columns: [col],
      sql: `"${col}" IS NULL OR "${col}" >= 0`,
    })),
  ]
}
