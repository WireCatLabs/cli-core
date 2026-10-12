import { describe, expect, it } from "vitest"
import { columnName, sheetText } from "./sheets.js"

const grid = (rows: (string | undefined)[][], first = 1) =>
  rows.flatMap((values, index) =>
    values.flatMap((value, column) => (value === undefined ? [] : [{ row: first + index, column: column + 1, value }])),
  )

describe("sheetText", () => {
  it("**repeats the header names on every row** and leaves empty cells, rows and columns out", () => {
    const cells = grid([
      ["Item", undefined, "Amount", "Note"],
      ["Rent", undefined, "1200", ""],
      [],
      ["Heron food", undefined, "42.5", "line one\nline two"],
    ])
    expect(sheetText([{ name: "Budget", cells }])).toEqual({
      text: "# Budget\nRow 2: Item: Rent; Amount: 1200\nRow 4: Item: Heron food; Amount: 42.5; Note: line one line two",
      truncated: false,
    })
  })

  it("names columns by letter when the first row is not a header", () => {
    const numbers = grid([
      ["1", "2"],
      ["3", "4"],
    ])
    const alone = grid([["only row", "x"]], 5)
    const twice = grid([
      ["Name", "Name"],
      ["a", "b"],
    ])
    expect(sheetText([{ name: "N", cells: numbers }]).text).toBe("# N\nRow 1: A: 1; B: 2\nRow 2: A: 3; B: 4")
    expect(sheetText([{ name: "One", cells: alone }]).text).toBe("# One\nRow 5: A: only row; B: x")
    expect(sheetText([{ name: "Twice", cells: twice }]).text).toBe(
      "# Twice\nRow 1: A: Name; B: Name\nRow 2: A: a; B: b",
    )
  })

  it("uses the letter for a column the header leaves blank, and separates sheets", () => {
    const first = grid([["Name"], ["Ann", "extra"]])
    const second = grid([["Q"], ["1"]])
    expect(
      sheetText([
        { name: "First", cells: first },
        { name: "Empty", cells: [] },
        { name: "Second", cells: second },
      ]).text,
    ).toBe("# First\nRow 2: Name: Ann; B: extra\n\n# Second\nRow 2: Q: 1")
  })

  it("stops at a row boundary when the text would be too long", () => {
    const cells = grid([["Name"], ["a"], ["b"], ["c"]])
    expect(sheetText([{ name: "S", cells }], 34)).toEqual({
      text: "# S\nRow 2: Name: a\nRow 3: Name: b",
      truncated: true,
    })
  })

  it("letters columns past Z", () => {
    expect([1, 26, 27, 52, 703].map(columnName)).toEqual(["A", "Z", "AA", "AZ", "AAA"])
  })
})
