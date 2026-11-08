import { CATALOG_KINDS, type CatalogKind, productLine } from "../../domain/business.js"
import { currencyOf, formatDecimal, minorUnits, scaleOf } from "../../domain/money.js"
import { fold } from "../normalize.js"
import { type Author, authorActor, authorOf } from "./memories.js"
import { requiredThing } from "./notes.js"
import type { StoreContext } from "./open.js"
import {
  type AuthorInfo,
  iso,
  isoDate,
  limitOf,
  oneOf,
  type Party,
  refuse,
  reviewedRowsOver,
  text,
} from "./reviewed.js"
import { write } from "./transaction.js"

export interface Product {
  id: string
  ref: string
  /** One line, as a list prints it. */
  title: string
  kind: CatalogKind
  name: string
  sku: string | null
  /** `null` for the owner's own item. */
  supplier: Party | null
  unit: string | null
  /** Both `null` when it has no price. */
  unitPrice: string | null
  currency: string | null
  description: string | null
  /** `YYYY-MM-DD`: no longer sold; its lines and subscriptions keep pointing at it. */
  archivedDate: string | null
  author: AuthorInfo
  model: string | null
  source: string
  createdAt: string
  updatedAt: string
}

export interface ProductInput {
  /** The owner and an agent write alike: a product feeds no total. */
  by: Author
  /** `product` when left out. */
  kind?: CatalogKind
  name: string
  sku?: string
  /** `person:` or `organization:`; the owner's own item when left out. */
  supplier?: string
  unit?: string
  /** A decimal string in `currency`; give both or neither. */
  unitPrice?: string
  currency?: string
  description?: string
  /** Where an agent's row came from, such as `agent`; the owner's is always `owner`. */
  source?: string
}

export interface ProductUpdate {
  by: Author
  name?: string
  unit?: string | null
  /** Give both, or neither. A new price changes no line: each line holds its own copy; `null` for both drops it. */
  unitPrice?: string | null
  currency?: string | null
  description?: string | null
  /** `YYYY-MM-DD` to stop selling it, `null` to sell it again. */
  archivedDate?: string | null
}

export interface ProductFilter {
  kind?: CatalogKind
  supplier?: string
  /** `true` only archived ones, `false` only those still sold; both when left out. */
  archived?: boolean
  /** Words of the name, in any letter case. */
  name?: string
  /** 1–500, 100 by default; by name. */
  limit?: number
}

/** What the owner or a supplier sells, written directly by the owner or an agent. */
export interface ProductsStore {
  add(input: ProductInput): Promise<Product>
  get(reference: string): Promise<Product>
  list(filter?: ProductFilter): Promise<Product[]>
  update(reference: string, input: ProductUpdate): Promise<Product>
}

type Row = Record<string, unknown>

const PRODUCTS =
  "SELECT c.*, b.name AS author_name, b.kind AS author_kind FROM catalog_items c " +
  "LEFT JOIN bots b ON c.author_type = 'bot' AND b.id = c.author_id"

type ProductOperations = {
  [K in keyof ProductsStore]: ProductsStore[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => R
    : never
}

export const productOperationsOver = (context: StoreContext): ProductOperations => {
  const { database, now } = context
  const { partyOf, partyThing } = reviewedRowsOver(context)

  const productOf = (row: Row): Product => {
    const currency = row.currency == null ? null : String(row.currency)
    const units = row.unit_price == null || currency === null ? null : Number(row.unit_price)
    const fields = {
      name: String(row.name),
      kind: row.kind as CatalogKind,
      unitPrice: units,
      currency,
      unit: row.unit == null ? null : String(row.unit),
      archived: row.archived_date != null,
    }
    return {
      id: String(row.id),
      ref: `product:${row.id}`,
      title: productLine(fields),
      kind: fields.kind,
      name: fields.name,
      sku: row.sku == null ? null : String(row.sku),
      supplier: partyOf(row.supplier_type, row.supplier_id),
      unit: fields.unit,
      unitPrice: units === null || currency === null ? null : formatDecimal(units, scaleOf(currency)),
      currency,
      description: row.description == null ? null : String(row.description),
      archivedDate: row.archived_date == null ? null : String(row.archived_date),
      author: authorOf(row),
      model: row.model == null ? null : String(row.model),
      source: String(row.source),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    }
  }

  const rowOf = (reference: string): Row => {
    const thing = requiredThing(database, reference.includes(":") ? reference : `product:${reference}`, "the product")
    if (thing.type !== "product") return refuse(`${reference} is not a product`, "product.ref")
    return database.prepare(`${PRODUCTS} WHERE c.id = ?`).get(thing.id) as Row
  }

  const priceOf = (unitPrice: string | null | undefined, currency: string | null | undefined) => {
    if ((unitPrice == null) !== (currency == null))
      refuse("a product's price and currency come together", "product.field")
    if (unitPrice == null || currency == null) return { units: null, currency: null }
    const code = currencyOf(currency)
    return { units: minorUnits(unitPrice, code, "a product's price"), currency: code }
  }

  const skuTaken = (sku: string, supplier: { type: string; id: number } | undefined, except: number | null) =>
    database
      .prepare(
        "SELECT id FROM catalog_items WHERE sku = ? AND deleted_at IS NULL AND supplier_type IS ? AND supplier_id IS ? " +
          "AND id IS NOT ?",
      )
      .get(sku, supplier?.type ?? null, supplier?.id ?? null, except)

  return {
    add: (input) => {
      const kind = input.kind === undefined ? "product" : oneOf(input.kind, CATALOG_KINDS, "a product's kind")
      const name = text(input.name, "a product's name", 200) ?? refuse("a product needs a name", "product.field")
      const sku = text(input.sku, "a product's code", 80)
      const unit = text(input.unit, "a product's unit", 40)
      const description = text(input.description, "a product's description", 2000)
      const price = priceOf(input.unitPrice, input.currency)
      const id = write(database, () => {
        const supplier = partyThing(input.supplier, "the supplier")
        if (sku !== null && skuTaken(sku, supplier, null))
          refuse(`a product with the code ${sku} is already stored for that supplier`, "product.duplicate")
        const { actor, model } = authorActor(context, input.by)
        const source = input.by === "owner" ? "owner" : (text(input.source, "a source", 80) ?? "agent")
        const at = now()
        return Number(
          database
            .prepare(
              "INSERT INTO catalog_items (kind, name, name_folded, sku, supplier_type, supplier_id, unit, unit_price, " +
                "currency, description, author_type, author_id, model, source, created_at, updated_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
            )
            .get(
              kind,
              name,
              fold(name),
              sku,
              supplier?.type ?? null,
              supplier?.id ?? null,
              unit,
              price.units,
              price.currency,
              description,
              actor.type,
              actor.id,
              model,
              source,
              at,
              at,
            )?.id,
        )
      })
      return productOf(rowOf(`product:${id}`))
    },
    get: (reference) => productOf(rowOf(reference)),
    list: (filter = {}) => {
      const kind = filter.kind === undefined ? null : oneOf(filter.kind, CATALOG_KINDS, "a kind")
      const supplier = partyThing(filter.supplier, "the supplier")
      const archived = filter.archived === undefined ? null : filter.archived ? 1 : 0
      const words = filter.name === undefined ? [] : fold(filter.name).split(/\s+/).filter(Boolean)
      const limit = limitOf(filter.limit)
      return database
        .prepare(
          `${PRODUCTS} WHERE c.deleted_at IS NULL AND (? IS NULL OR c.kind = ?) ` +
            "AND (? IS NULL OR (c.supplier_type = ? AND c.supplier_id = ?)) " +
            "AND (? IS NULL OR (c.archived_date IS NOT NULL) = ?) ORDER BY c.name_folded, c.id",
        )
        .all(kind, kind, supplier?.type ?? null, supplier?.type ?? null, supplier?.id ?? null, archived, archived)
        .filter((row) => words.every((word) => String(row.name_folded).includes(word)))
        .slice(0, limit)
        .map(productOf)
    },
    update: (reference, input) => {
      const row = rowOf(reference)
      if (row.deleted_at != null) refuse(`product:${row.id} is deleted`, "product.ref")
      authorActor(context, input.by)
      const name = input.name === undefined ? String(row.name) : (text(input.name, "a product's name", 200) as string)
      const unit = input.unit === undefined ? row.unit : text(input.unit, "a product's unit", 40)
      const description =
        input.description === undefined ? row.description : text(input.description, "a product's description", 2000)
      const price =
        input.unitPrice === undefined && input.currency === undefined
          ? { units: row.unit_price as number | null, currency: row.currency as string | null }
          : priceOf(input.unitPrice, input.currency)
      const archived =
        input.archivedDate === undefined ? row.archived_date : isoDate(input.archivedDate, "the day it stopped selling")
      write(database, () => {
        database
          .prepare(
            "UPDATE catalog_items SET name = ?, name_folded = ?, unit = ?, unit_price = ?, currency = ?, description = ?, " +
              "archived_date = ?, updated_at = ? WHERE id = ?",
          )
          .run(
            name,
            fold(name),
            unit as string | null,
            price.units,
            price.currency,
            description as string | null,
            archived as string | null,
            now(),
            Number(row.id),
          )
      })
      return productOf(rowOf(`product:${row.id}`))
    },
  }
}

export const productsStoreOver = (context: StoreContext): ProductsStore => {
  const operations = productOperationsOver(context)
  return {
    add: async (input) => operations.add(input),
    get: async (reference) => operations.get(reference),
    list: async (filter) => operations.list(filter),
    update: async (reference, input) => operations.update(reference, input),
  }
}
