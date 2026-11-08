import { fold } from "../normalize.js"
import type { AccountKey } from "../types.js"
import type { StoreContext } from "./open.js"

/** What the `business` lane of `search all` reads; transactions are too many to fold per query. */
export const BUSINESS_KINDS = ["invoice", "payment", "order", "contract", "subscription", "product", "wallet"] as const
export type BusinessKind = (typeof BUSINESS_KINDS)[number]

export interface BusinessSearch {
  /** Words of a number or a name, each in any letter case; a word may be a phrase. */
  words: string[]
  /** A row holding any of the words matches, those holding more first; otherwise every word is needed. */
  anyWord?: boolean
  /** Only what imports of these accounts made; absent, every import's and the owner's own. */
  accounts?: AccountKey[]
  /** 1–500, 100 by default. */
  limit?: number
}

/** The source record an import made the entity from. */
export interface BusinessSource {
  provider: string
  account: string
  externalId: string
}

export interface BusinessHit {
  kind: BusinessKind
  ref: string
  /** A product's or a wallet's has no review and reads `confirmed`; rejected rows are never found. */
  review: "proposed" | "confirmed"
  /** Absent for a row the owner or an agent wrote. */
  source?: BusinessSource
  /** The numbers and names it was found by, one line. */
  text: string
  /** Epoch ms. */
  updatedAt: number
}

export interface BusinessSearchStore {
  find(search: BusinessSearch): Promise<BusinessHit[]>
  /** Every account whose import made a row the lane reads. */
  accounts(): Promise<AccountKey[]>
}

const party = (kind: string, id: string, as: string) =>
  `LEFT JOIN persons ${as}p ON ${kind} = 'person' AND ${as}p.id = ${id} AND ${as}p.owner = 0 ` +
  `LEFT JOIN organizations ${as}o ON ${kind} = 'organization' AND ${as}o.id = ${id} ` +
  `LEFT JOIN projects ${as}j ON ${kind} = 'project' AND ${as}j.id = ${id}`
const partyName = (as: string) => `coalesce(${as}p.name, ${as}o.name, ${as}j.name)`

const LIVE = "x.deleted_at IS NULL"
const DECIDED = `${LIVE} AND x.review <> 'rejected'`

/** Each kind's searched text as columns `f1…`; a `NULL` column is left out. */
const SEARCHED: Record<BusinessKind, string> = {
  invoice:
    `SELECT x.id, x.review, x.updated_at, x.number AS f1, ${partyName("c")} AS f2 FROM invoices x ` +
    `${party("x.counterparty_type", "x.counterparty_id", "c")} WHERE ${DECIDED}`,
  payment:
    `SELECT x.id, x.review, x.updated_at, x.reference AS f1, ${partyName("r")} AS f2, ${partyName("e")} AS f3 ` +
    `FROM payments x ${party("x.payer_type", "x.payer_id", "r")} ${party("x.payee_type", "x.payee_id", "e")} ` +
    `WHERE ${DECIDED}`,
  order:
    "SELECT x.id, x.review, x.updated_at, x.number AS f1, x.supplier_name AS f2, " +
    "(SELECT group_concat(description, char(10)) FROM order_lines WHERE order_id = x.id) AS f3 " +
    `FROM orders x WHERE ${DECIDED}`,
  contract: `SELECT x.id, x.review, x.updated_at, x.name AS f1, x.number AS f2 FROM contracts x WHERE ${DECIDED}`,
  subscription: `SELECT x.id, x.review, x.updated_at, x.name AS f1 FROM subscriptions x WHERE ${DECIDED}`,
  product:
    "SELECT x.id, 'confirmed' AS review, x.updated_at, x.name AS f1, x.sku AS f2 FROM catalog_items x " +
    `WHERE ${LIVE}`,
  wallet:
    "SELECT x.id, 'confirmed' AS review, x.updated_at, x.name AS f1, x.institution AS f2 FROM financial_accounts x " +
    `WHERE ${LIVE}`,
}

const FIELDS = ["f1", "f2", "f3"] as const
const TEXT_CHARS = 240
const KINDS_SQL = BUSINESS_KINDS.map((kind) => `'${kind}'`).join(", ")

const keyOf = ({ provider, account }: AccountKey) => `${provider}\u0000${account}`

const lineOf = (parts: string[]) => {
  const line = parts.join(" · ").replace(/\s+/gu, " ").trim()
  return line.length <= TEXT_CHARS ? line : `${line.slice(0, TEXT_CHARS - 1)}…`
}

export const businessSearchOver = ({ database }: StoreContext): BusinessSearchStore => {
  /** Each entity's records, oldest first, so the one an import first made it from is its source. */
  const sourcesOf = (kind: BusinessKind, ids: number[]): Map<number, BusinessSource[]> => {
    const sources = new Map<number, BusinessSource[]>()
    if (!ids.length) return sources
    const rows = database
      .prepare(
        "SELECT r.entity_id, r.external_id, a.provider, a.external_id AS account FROM records r " +
          "JOIN accounts a ON a.id = r.account_id " +
          "WHERE r.entity_type = ? AND r.entity_id IN (SELECT value FROM json_each(?)) ORDER BY r.id",
      )
      .all(kind, JSON.stringify(ids))
    for (const row of rows) {
      const id = Number(row.entity_id)
      const held = sources.get(id) ?? []
      held.push({ provider: String(row.provider), account: String(row.account), externalId: String(row.external_id) })
      sources.set(id, held)
    }
    return sources
  }

  const find = ({ words, anyWord, accounts, limit }: BusinessSearch): BusinessHit[] => {
    const wanted = [...new Set(words.map((word) => fold(word).trim()).filter(Boolean))]
    if (!wanted.length) return []
    const most = Math.min(Math.max(limit ?? 100, 1), 500)
    const within = accounts === undefined ? undefined : new Set(accounts.map(keyOf))
    // Numbers and names are short; folding them here is cheaper than an index the store would keep in step.
    const found = BUSINESS_KINDS.flatMap((kind) => {
      const matched = database
        .prepare(SEARCHED[kind])
        .all()
        .flatMap((row) => {
          const parts = FIELDS.flatMap((field) => (row[field] == null ? [] : [String(row[field])]))
          // A newline between fields keeps a phrase from matching across two of them.
          const folded = fold(parts.join("\n"))
          const score = wanted.filter((word) => folded.includes(word)).length
          return (anyWord ? score > 0 : score === wanted.length) ? [{ kind, row, parts, score }] : []
        })
      const sources = sourcesOf(
        kind,
        matched.map(({ row }) => Number(row.id)),
      )
      return matched.flatMap((one) => {
        const all = sources.get(Number(one.row.id)) ?? []
        // Under a scope the owner's own rows have no account to be in, as `deals.find` leaves them out.
        const source = within === undefined ? all[0] : all.find((held) => within.has(keyOf(held)))
        return within !== undefined && source === undefined ? [] : [{ ...one, source }]
      })
    })
    return found
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(b.row.updated_at) - Number(a.row.updated_at) ||
          a.kind.localeCompare(b.kind) ||
          Number(b.row.id) - Number(a.row.id),
      )
      .slice(0, most)
      .map(({ kind, row, parts, source }) => ({
        kind,
        ref: `${kind}:${row.id}`,
        review: row.review === "proposed" ? "proposed" : "confirmed",
        ...(source === undefined ? {} : { source }),
        text: lineOf(parts),
        updatedAt: Number(row.updated_at),
      }))
  }

  const sourceAccounts = (): AccountKey[] =>
    database
      .prepare(
        "SELECT DISTINCT a.provider, a.external_id AS account FROM records r JOIN accounts a ON a.id = r.account_id " +
          `WHERE r.entity_type IN (${KINDS_SQL}) AND r.entity_id IS NOT NULL ORDER BY a.provider, a.external_id`,
      )
      .all()
      .map((row) => ({ provider: String(row.provider), account: String(row.account) }))

  return {
    find: async (search) => find(search),
    accounts: async () => sourceAccounts(),
  }
}
