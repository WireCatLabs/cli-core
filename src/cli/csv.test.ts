import { describe, expect, it } from "vitest"
import { csvCell } from "./csv.js"

describe("csvCell", () => {
  it("quotes a comma, a quote and a line end as RFC 4180 does", () => {
    expect(csvCell("a,b")).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell("one\r\ntwo")).toBe('"one\r\ntwo"')
    expect(csvCell(null)).toBe("")
  })

  it("guards text a spreadsheet would run as a formula, and leaves a number alone", () => {
    for (const text of ["=1+1", "+cmd", "-1+cmd", "@SUM(A1)", "\tx", "\rx"]) expect(csvCell(text)).toMatch(/^"?'/)
    expect(csvCell("-150.00")).toBe("-150.00")
    expect(csvCell(-3)).toBe("-3")
  })
})
