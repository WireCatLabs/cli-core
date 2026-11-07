import { CliError } from "@wirecat/cli-base"
import { formatDecimal, lineUnits, minorUnits, moneyLabel, quantityOf, scaleOf } from "../../domain/money.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"

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

const refuse = (message: string, reason: string): never => {
  throw new CliError("validation_error", message, { reason })
}

/** Invoice and order lines: quantity × unit price, in the parent's currency, a product's name and price copied. */
export const moneyLinesOver = ({ database }: StoreContext) => {
  const productOf = (reference: string, what: string): Record<string, unknown> => {
    const thing = requiredThing(database, reference, `${what}'s product`)
    if (thing.type !== "product")
      return refuse(`${what}'s product is a product: reference, not ${reference}`, "finance.lines")
    const row = database.prepare("SELECT * FROM catalog_items WHERE id = ?").get(thing.id) as Record<string, unknown>
    if (row.deleted_at != null) refuse(`product:${row.id} is deleted`, "finance.lines")
    return row
  }

  const priced = (line: MoneyLineInput, at: number, currency: string): PricedLine => {
    const what = `line ${at + 1}`
    const product = line.product === undefined ? null : productOf(line.product, what)
    const quantity = quantityOf(line.quantity ?? "1")
    const copied = product !== null && line.unitPrice === undefined && line.amount === undefined
    if (copied && product.unit_price != null && product.currency !== currency)
      refuse(
        `product:${product.id} is priced in ${String(product.currency)}; give ${what}'s price in ${currency}`,
        "finance.currency",
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
    if (amount === null) return refuse(`${what} takes a unit price, an amount or both`, "finance.lines")
    if (computed !== null && computed !== amount)
      refuse(
        `${what}: ${quantity.text} × ${moneyLabel(unitPrice as number, currency)} is ` +
          `${moneyLabel(computed, currency)}, not ${moneyLabel(amount, currency)}`,
        "finance.line-amount",
      )
    const description = line.description ?? (product === null ? undefined : String(product.name))
    if (
      description !== undefined &&
      (typeof description !== "string" || !description.trim() || description.length > 500 || description.includes("\0"))
    )
      refuse(`${what}'s description takes 1–500 characters`, "finance.field")
    return {
      description: description?.trim() ?? refuse(`${what} needs a description`, "finance.lines"),
      quantity: quantity.text,
      unitPrice: unitPrice ?? (quantity.thousandths === 1000n ? amount : null),
      amount,
      productId: product === null ? null : Number(product.id),
    }
  }

  const linesOf = (lines: MoneyLineInput[], currency: string): PricedLine[] =>
    lines.map((line, at) => priced(line, at, currency))

  const shownLines = (
    table: "invoice_lines" | "order_lines",
    column: "invoice_id" | "order_id",
    id: number,
    currency: string,
  ) => {
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

  return { linesOf, priced, shownLines }
}
