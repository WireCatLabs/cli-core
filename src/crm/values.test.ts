import { describe, expect, it } from "vitest"
import { SOURCE_FIELD } from "./testing/index.js"
import { amountOf, crmValuesOf, fullName, id, time } from "./values.js"
import { crmWindowOf, walk } from "./walk.js"

describe("CRM JSON helpers", () => {
  it("labels custom values, a list field's options by label beside their ids", () => {
    expect(crmValuesOf({ UF_SOURCE: "2", UF_TAGS: ["1", "2"], UF_FREE: "x" }, [SOURCE_FIELD])).toEqual({
      UF_SOURCE: { label: "Source", value: "Fair", option_id: "2" },
      UF_TAGS: { label: null, value: ["1", "2"] },
      UF_FREE: { label: null, value: "x" },
    })
  })

  it("reads times from ISO with an offset and from epoch seconds, ids without the 0 of no link, money both or neither", () => {
    expect(time("2026-11-15T10:00:00+03:00")).toBe("2026-11-15T07:00:00.000Z")
    expect(time(1_763_200_000)).toBe("2025-11-15T09:46:40.000Z")
    expect(id(0)).toBeNull()
    expect(amountOf("1500.50", "eur")).toEqual({ amount: "1500.50", currency: "EUR" })
    expect(amountOf(0, "EUR")).toEqual({ amount: null, currency: null })
    expect(fullName(" Anna ", null, "Example")).toBe("Anna Example")
  })

  it("walk reads a page over the CRM's smaller pages and knows has_more without a total", async () => {
    const rows = ["a", "b", "c", "d", "e"]
    const asked: [number, number][] = []
    const page = await walk(crmWindowOf({ limit: 2, page: "2" }), 2, async (offset, size) => {
      asked.push([offset, size])
      return { rows: rows.slice(offset, offset + size), more: offset + size < rows.length }
    })
    expect(page).toEqual({ items: ["c", "d"], hasMore: true })
    expect(asked).toEqual([
      [2, 2],
      [4, 1],
    ])
  })
})
