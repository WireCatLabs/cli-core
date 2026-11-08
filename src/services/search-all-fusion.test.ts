import { describe, expect, it } from "vitest"
import { oneList, type SearchAllItem } from "./search-all.js"

const hit = (ref: string, kind: SearchAllItem["kind"], foundBy: SearchAllItem["foundBy"]): SearchAllItem => ({
  kind,
  ref,
  provider: kind,
  account: "a",
  title: ref,
  timestamp: "2026-11-08T00:00:00Z",
  text: "",
  foundBy,
})

const order = (
  lists: SearchAllItem[][],
  words: Record<string, number>,
  cosines: Record<string, number>,
  rule = { k: 3, head: false },
) => oneList(lists, new Map(Object.entries(words)), (ref) => cosines[ref], rule).map(({ ref }) => ref)

describe("search all's one list by rank fusion", () => {
  const mail = [hit("m1", "mail", ["words"]), hit("m2", "mail", ["meaning"]), hit("m3", "mail", ["words", "meaning"])]
  const notes = [hit("n1", "note", ["words", "meaning"]), hit("n2", "note", ["meaning"])]

  it("keeps an exact word at words rank 1 near the top though its cosine is middling", () => {
    const found = order([mail, notes], { m1: 0, m3: 1, n1: 0 }, { m1: 0.8, m2: 0.88, m3: 0.86, n1: 0.87, n2: 0.85 })

    expect(found.indexOf("m1")).toBeLessThan(3)
    expect(found[0]).toBe("n1")
  })

  it("orders hits meaning alone found by their cosine across sources", () => {
    const found = order([mail, notes], { m1: 0, m3: 1, n1: 0 }, { m1: 0.8, m2: 0.88, m3: 0.86, n1: 0.87, n2: 0.85 })

    expect(found.indexOf("m2")).toBeLessThan(found.indexOf("n2"))
  })

  it("ranks a hit with no vector by its words rank alone, after the hits that have both", () => {
    const found = order([mail, notes], { m1: 0, m3: 1, n1: 0 }, { m2: 0.88, m3: 0.86, n1: 0.87, n2: 0.85 })

    expect(found).toContain("m1")
    expect(found.indexOf("n1")).toBeLessThan(found.indexOf("m1"))
  })

  it("puts each source's best hit first when asked", () => {
    const found = order(
      [mail, notes],
      { m1: 0, m3: 1, n1: 0 },
      { m1: 0.5, m2: 0.88, m3: 0.86, n1: 0.87 },
      {
        k: 3,
        head: true,
      },
    )

    expect(found.slice(0, 2).sort()).toEqual(["m1", "n1"])
  })

  it("takes a list's own order as the words rank of a source that gives none", () => {
    const crm = [hit("d1", "deal", ["title"]), hit("d2", "deal", ["title"])]

    expect(order([crm], {}, {})).toEqual(["d1", "d2"])
  })
})
