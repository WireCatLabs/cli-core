import { CliError } from "@wirecat/cli-base"
import { formatDecimal, lineUnits, minorUnits, moneyLabel, quantityOf, scaleOf } from "../../domain/money.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import { refuse, text } from "./reviewed.js"

export interface MoneyLineInput {
  /** Taken from the product when left out. */
  description?: string
  /** A decimal string; `1` when not given. */
  quantity?: string
  /** Decimal strings in the parent's currency. Give either or both: both must agree, quantity × unit price. */
  unitPrice?: string
  amount?: string
  /** `product:<id>`: its name and price are copied onto the line, and a later price change leaves the line as it is. */
  product?: string
}

export interface MoneyLine {
  position: number
  description: string
  quantity: string
  unitPrice: string | null
  amount: string
  product: string | null
}

export interface PricedLine {
  description: string
  quantity: string
  unitPrice: number | null
  amount: number
  productId: number | null
}

export const MAX_LINES = 500

/** Where each parent keeps its lines, and the reasons its line errors carry. */
const PARENTS = {
  invoice: {
    parents: "invoices",
    table: "invoice_lines",
    column: "invoice_id",
    reasons: "finance",
    full: "finance.lines",
    instead: "reject or void the invoice instead",
  },
  order: {
    parents: "orders",
    table: "order_lines",
    column: "order_id",
    reasons: "order",
    full: "order.field",
    instead: "reject or cancel the order instead",
  },
} as const

export type LineParent = keyof typeof PARENTS

/** Invoice and order lines: quantity × unit price, in the parent's currency, a product's name and price copied. */
export const moneyLinesOver = ({ database }: StoreContext) => {
  const productOf = (reference: string, what: string, code: (name: string) => string): Record<string, unknown> => {
    const thing = requiredThing(database, reference, `${what}'s product`)
    if (thing.type !== "product")
      return refuse(`${what}'s product is a product: reference, not ${reference}`, code("lines"))
    const row = database.prepare("SELECT * FROM catalog_items WHERE id = ?").get(thing.id) as Record<string, unknown>
    if (row.deleted_at != null) refuse(`product:${row.id} is deleted`, code("lines"))
    return row
  }

  const priced = (parent: LineParent, line: MoneyLineInput, at: number, currency: string): PricedLine => {
    const code = (name: string) => `${PARENTS[parent].reasons}.${name}`
    const what = `line ${at + 1}`
    const product = line.product === undefined ? null : productOf(line.product, what, code)
    const quantity = quantityOf(line.quantity ?? "1")
    const copied = product !== null && line.unitPrice === undefined && line.amount === undefined
    if (copied && product.unit_price != null && product.currency !== currency)
      refuse(
        `product:${product.id} is priced in ${String(product.currency)}; give ${what}'s price in ${currency}`,
        code("currency"),
      )
    const unitPrice = copied
      ? product.unit_price == null
        ? null
        : Number(product.unit_price)
      : line.unitPrice === undefined
        ? null
        : minorUnits(line.unitPrice, currency, `${what}'s unit price`)
    const computed = unitPrice === null ? null : lineUnits(quantity.thousandths, unitPrice)
    const amount = line.amount === undefined ? computed : minorUnits(line.amount, currency, `${what}'s amount`)
    if (amount === null) return refuse(`${what} takes a unit price, an amount or both`, code("lines"))
    if (computed !== null && computed !== amount)
      refuse(
        `${what}: ${quantity.text} × ${moneyLabel(unitPrice as number, currency)} is ` +
          `${moneyLabel(computed, currency)}, not ${moneyLabel(amount, currency)}`,
        code("line-amount"),
      )
    const description =
      text(
        line.description ?? (product === null ? undefined : String(product.name)),
        `${what}'s description`,
        500,
        code("field"),
      ) ?? refuse(`${what} needs a description`, code("lines"))
    return {
      description,
      quantity: quantity.text,
      unitPrice: unitPrice ?? (quantity.thousandths === 1000n ? amount : null),
      amount,
      productId: product === null ? null : Number(product.id),
    }
  }

  const linesOf = (parent: LineParent, lines: MoneyLineInput[], currency: string): PricedLine[] =>
    lines.map((line, at) => priced(parent, line, at, currency))

  /** Writes lines from position `from` on. */
  const insertLines = (parent: LineParent, id: number, lines: PricedLine[], from: number, at: number) => {
    const { table, column } = PARENTS[parent]
    const insert = database.prepare(
      `INSERT INTO ${table} (${column}, position, description, quantity, unit_price, amount, catalog_item_id, ` +
        "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    for (const [index, line] of lines.entries())
      insert.run(id, from + index, line.description, line.quantity, line.unitPrice, line.amount, line.productId, at, at)
  }

  const shownLines = (parent: LineParent, id: number, currency: string) => {
    const { table, column } = PARENTS[parent]
    const scale = scaleOf(currency)
    return database
      .prepare(`SELECT * FROM ${table} WHERE ${column} = ? ORDER BY position`)
      .all(id)
      .map(
        (line): MoneyLine => ({
          position: Number(line.position),
          description: String(line.description),
          quantity: String(line.quantity),
          unitPrice: line.unit_price == null ? null : formatDecimal(Number(line.unit_price), scale),
          amount: formatDecimal(Number(line.amount), scale),
          product: line.catalog_item_id == null ? null : `product:${line.catalog_item_id}`,
        }),
      )
  }

  /** Writes a line after the last one; the caller retotals the parent in the same write. */
  const appendLine = (parent: LineParent, id: number, line: PricedLine, at: number) => {
    const { table, column, full } = PARENTS[parent]
    const last = Number(
      database.prepare(`SELECT coalesce(max(position), 0) AS n FROM ${table} WHERE ${column} = ?`).get(id)?.n,
    )
    if (last >= MAX_LINES) refuse(`an ${parent} has at most ${MAX_LINES} lines`, full)
    insertLines(parent, id, [line], last + 1, at)
  }

  /** Removes one line, never the last; the caller retotals the parent in the same write. */
  const deleteLine = (parent: LineParent, id: number, position: number) => {
    const { table, column, reasons, instead } = PARENTS[parent]
    const lines = Number(database.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get(id)?.n)
    const gone = database.prepare(`DELETE FROM ${table} WHERE ${column} = ? AND position = ?`).run(id, position)
    if (gone.changes === 0)
      throw new CliError("not_found", `${parent}:${id} has no line ${position}`, { reason: `${reasons}.no-line` })
    if (lines === 1) refuse(`line ${position} is the last of ${parent}:${id}; ${instead}`, `${reasons}.line`)
  }

  const sumOf = (parent: LineParent, id: number): number => {
    const { table, column } = PARENTS[parent]
    return Number(database.prepare(`SELECT coalesce(sum(amount), 0) AS n FROM ${table} WHERE ${column} = ?`).get(id)?.n)
  }

  /** The parent's total follows its lines: orders' trigger checks the sum when the order changes. */
  const retotal = (parent: LineParent, id: number, at: number) => {
    const { parents, table, column } = PARENTS[parent]
    database
      .prepare(
        `UPDATE ${parents} SET total = coalesce((SELECT sum(amount) FROM ${table} WHERE ${column} = ?), total), ` +
          "updated_at = ? WHERE id = ?",
      )
      .run(id, at, id)
  }

  return { linesOf, insertLines, shownLines, appendLine, deleteLine, sumOf, retotal }
}
