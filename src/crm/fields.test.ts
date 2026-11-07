import { describe, expect, it } from "vitest"
import { fieldNamed, fieldPairsOf, foldFieldName, optionOf } from "./index.js"

const fields = [
  { code: "UF_SOURCE", label: "Lead source", options: [{ id: "7", label: "Сайт ёлки" }] },
  { code: "UF_CITY", label: "Город", options: undefined },
  { code: "UF_CITY_2", label: "город" },
]

describe("the CRM field lookup a CRM CLI shares", () => {
  it("folds case, composed letters, ё, spaces and underscores", () => {
    expect(foldFieldName("  Lead_Source ")).toBe(foldFieldName("lead source"))
    expect(foldFieldName("ЁЛКА")).toBe("елка")
  })

  it("finds a field by its code or whole label, and refuses a label two fields share", () => {
    expect(fieldNamed(fields, "uf_source").code).toBe("UF_SOURCE")
    expect(fieldNamed(fields, "lead_source").code).toBe("UF_SOURCE")
    expect(() => fieldNamed(fields, "Город")).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: "field.ambiguous" }) }),
    )
    expect(() => fieldNamed(fields, "source")).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({
          reason: "field.unknown",
          candidates: [{ code: "UF_SOURCE", label: "Lead source" }],
        }),
      }),
    )
  })

  it("takes an option by its id or its label typed with е for ё", () => {
    const [source] = fields
    expect(source && optionOf(source, "7")).toBe("7")
    expect(source && optionOf(source, "сайт елки")).toBe("7")
  })

  it("splits --field pairs at the first = and refuses one with no key", () => {
    expect(fieldPairsOf(["UF_NOTE=a=b", "UF_CITY="])).toEqual([
      ["UF_NOTE", "a=b"],
      ["UF_CITY", ""],
    ])
    expect(() => fieldPairsOf(["=x"])).toThrow(/--field takes <key>=<value>/)
  })
})
