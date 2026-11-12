import type { ListResult } from "@wirecat/cli-base/standards"
import { BUSINESS_KINDS, type BusinessKind } from "../../domain/business.js"
import { fold } from "../normalize.js"
import type { AccountKey } from "../types.js"
import type { StoreContext } from "./open.js"
import { pageOfRows } from "./rows-page.js"

/** The most rows one `find` answers: a `search all` page read as deep as its offset allows, and one more. */
export const BUSINESS_FIND_MAX = 2001

export interface BusinessSearch {
  /** Words of a number or a name, each matched at the start of a word in any letter case; a word may be a phrase. */
  words: string[]
  /** A row holding any of the words matches, those holding more first; otherwise every word is needed. */
  anyWord?: boolean
  /** Only what imports of these accounts made; absent, every import's and the owner's own. */
  accounts?: AccountKey[]
  /** 1–`BUSINESS_FIND_MAX`, 100 by default. */
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
  /** The import provider of a row an import made; absent for the owner's or an agent's. */
  imported?: string
  /** The one record that names the row's account: the oldest live one, else the oldest deleted one. */
  source?: BusinessSource
  /** The numbers and names it was found by, one line. */
  text: string
  /** Epoch ms. */
  updatedAt: number
}

/** Invoices, payments, orders, contracts, subscriptions, products and wallets, found by their numbers and names. */
export interface BusinessSearchStore {
  find(search: BusinessSearch): Promise<ListResult<BusinessHit>>
  /** Every account with a live record of a row the lane reads. */
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
    `SELECT x.id, x.review, x.source, x.updated_at, x.number AS f1, ${partyName("c")} AS f2 FROM invoices x ` +
    `${party("x.counterparty_type", "x.counterparty_id", "c")} WHERE ${DECIDED}`,
  payment:
    "SELECT x.id, x.review, x.source, x.updated_at, x.reference AS f1, " +
    `${partyName("r")} AS f2, ${partyName("e")} AS f3 FROM payments x ` +
    `${party("x.payer_type", "x.payer_id", "r")} ${party("x.payee_type", "x.payee_id", "e")} WHERE ${DECIDED}`,
  order:
    "SELECT x.id, x.review, x.source, x.updated_at, x.number AS f1, x.supplier_name AS f2, " +
    "(SELECT group_concat(description, char(10)) FROM order_lines WHERE order_id = x.id) AS f3 " +
    `FROM orders x WHERE ${DECIDED}`,
  contract:
    "SELECT x.id, x.review, x.source, x.updated_at, x.name AS f1, x.number AS f2 FROM contracts x " +
    `WHERE ${DECIDED}`,
  subscription: `SELECT x.id, x.review, x.source, x.updated_at, x.name AS f1 FROM subscriptions x WHERE ${DECIDED}`,
  product:
    "SELECT x.id, 'confirmed' AS review, x.source, x.updated_at, x.name AS f1, x.sku AS f2 FROM catalog_items x " +
    `WHERE ${LIVE}`,
  wallet:
    "SELECT x.id, 'confirmed' AS review, x.source, x.updated_at, x.name AS f1, x.institution AS f2 " +
    `FROM financial_accounts x WHERE ${LIVE}`,
}

const FIELDS = ["f1", "f2", "f3"] as const
const TEXT_CHARS = 240
const KINDS_SQL = BUSINESS_KINDS.map((kind) => `'${kind}'`).join(", ")
const IMPORT = "import:"
const WORD_CHAR = /[\p{L}\p{N}]/u

const keyOf = ({ provider, account }: AccountKey) => `${provider}\u0000${account}`

const lineOf = (parts: string[]) => {
  const line = parts.join(" · ").replace(/\s+/gu, " ").trim()
  return line.length <= TEXT_CHARS ? line : `${line.slice(0, TEXT_CHARS - 1)}…`
}

/** "get" finds "Get well" and "INV-get", never "Widget": a word is matched where a word starts. */
export const startsAWord = (folded: string, word: string): boolean => {
  for (let at = folded.indexOf(word); at !== -1; at = folded.indexOf(word, at + 1))
    if (at === 0 || !WORD_CHAR.test(folded[at - 1] as string)) return true
  return false
}

interface Matched {
  kind: BusinessKind
  id: number
  review: "proposed" | "confirmed"
  imported: string | undefined
  parts: string[]
  score: number
  updatedAt: number
}

export const businessSearchOver = ({ database }: StoreContext): BusinessSearchStore => {
  const matchedOf = (kind: BusinessKind, wanted: string[], anyWord: boolean): Matched[] =>
    database
      .prepare(SEARCHED[kind])
      .all()
      .flatMap((row) => {
        const parts = FIELDS.flatMap((field) => (row[field] == null ? [] : [String(row[field])]))
        // A newline between fields keeps a phrase from matching across two of them.
        const folded = fold(parts.join("\n"))
        const score = wanted.filter((word) => startsAWord(folded, word)).length
        if (anyWord ? score === 0 : score < wanted.length) return []
        const source = String(row.source)
        return [
          {
            kind,
            id: Number(row.id),
            review: row.review === "proposed" ? "proposed" : "confirmed",
            imported: source.startsWith(IMPORT) ? source.slice(IMPORT.length) : undefined,
            parts,
            score,
            updatedAt: Number(row.updated_at),
          },
        ]
      })

  /**
   * The one record that names each imported row's account. A record the owner mapped onto the row later never moves
   * it; a deleted record counts only when no live one is left.
   */
  const sourcesOf = (matched: readonly Matched[]): Map<string, BusinessSource> => {
    const sources = new Map<string, BusinessSource>()
    for (const kind of BUSINESS_KINDS) {
      const ids = matched.filter((one) => one.kind === kind && one.imported !== undefined).map(({ id }) => id)
      if (!ids.length) continue
      const rows = database
        .prepare(
          "SELECT r.entity_id, r.external_id, a.provider, a.external_id AS account FROM records r " +
            "JOIN accounts a ON a.id = r.account_id " +
            "WHERE r.entity_type = ? AND r.entity_id IN (SELECT value FROM json_each(?)) " +
            "ORDER BY r.entity_id, (r.deleted_at IS NOT NULL), r.id",
        )
        .all(kind, JSON.stringify(ids))
      for (const row of rows) {
        const ref = `${kind}:${row.entity_id}`
        if (!sources.has(ref))
          sources.set(ref, {
            provider: String(row.provider),
            account: String(row.account),
            externalId: String(row.external_id),
          })
      }
    }
    return sources
  }

  const find = ({ words, anyWord = false, accounts, limit }: BusinessSearch): ListResult<BusinessHit> => {
    const wanted = [...new Set(words.map((word) => fold(word).trim()).filter(Boolean))]
    if (!wanted.length) return { items: [], hasMore: false }
    const most = Math.min(Math.max(limit ?? 100, 1), BUSINESS_FIND_MAX)
    const within = accounts === undefined ? undefined : new Set(accounts.map(keyOf))
    // Numbers and names are short; folding them here is cheaper than an index the store would keep in step.
    const matched = BUSINESS_KINDS.flatMap((kind) => matchedOf(kind, wanted, anyWord)).sort(
      (a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.kind.localeCompare(b.kind) || b.id - a.id,
    )
    // Without a scope only the page needs its records; with one, every match is checked against it first.
    const candidates = within === undefined ? matched.slice(0, most + 1) : matched.filter((one) => one.imported)
    const sources = sourcesOf(candidates)
    const kept =
      within === undefined
        ? candidates
        : candidates
            .filter((one) => {
              const source = sources.get(`${one.kind}:${one.id}`)
              return source !== undefined && within.has(keyOf(source))
            })
            .slice(0, most + 1)
    const hits = kept.map((one): BusinessHit => {
      const ref = `${one.kind}:${one.id}`
      const source = sources.get(ref)
      return {
        kind: one.kind,
        ref,
        review: one.review,
        ...(one.imported === undefined ? {} : { imported: one.imported }),
        ...(source === undefined ? {} : { source }),
        text: lineOf(one.parts),
        updatedAt: one.updatedAt,
      }
    })
    return pageOfRows(hits, most)
  }

  const sourceAccounts = (): AccountKey[] =>
    database
      .prepare(
        "SELECT DISTINCT a.provider, a.external_id AS account FROM records r JOIN accounts a ON a.id = r.account_id " +
          `WHERE r.entity_type IN (${KINDS_SQL}) AND r.entity_id IS NOT NULL AND r.deleted_at IS NULL ` +
          "ORDER BY a.provider, a.external_id",
      )
      .all()
      .map((row) => ({ provider: String(row.provider), account: String(row.account) }))

  return {
    find: async (search) => find(search),
    accounts: async () => sourceAccounts(),
  }
}
