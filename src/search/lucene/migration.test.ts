import { parseLucene } from "@wirecat/cli-base/query"
import { describe, expect, it } from "vitest"
import { migrateLegacyQuery } from "./migration.js"

describe("explicit legacy migration preview", () => {
  it("makes legacy OR grouping explicit and preserves quoted values/exclusions", () => {
    const migrated = migrateLegacyQuery('alpha OR beta gamma -delta from:"A B" chat:"Work" has:file in:max', {
      providers: ["max"],
    })
    expect(migrated.query).toBe(
      "(“alpha” OR “beta”) AND “gamma” AND NOT “delta” AND from:“A B” AND chat:“Work” AND in:“max” AND has:“file”"
        .replaceAll("“", '"')
        .replaceAll("”", '"'),
    )
    expect(migrated.ast).toEqual(parseLucene(migrated.query))
    expect(migrated.warnings[0]).toContain("does not preserve")
  })
  it("preserves legacy time instants instead of guessing a different timezone/day rule", () => {
    const migrated = migrateLegacyQuery("after:7d before:1d", { now: Date.parse("2026-01-10T10:00:00Z") })
    expect(migrated.query).toBe('date:["2026-01-03T10:00:00.000Z" TO *] AND date:[* TO "2026-01-09T10:00:00.000Z"}')
  })
  it("reports formerly tolerated malformed quotes, escapes symbols and handles filter-only/empty queries", () => {
    expect(migrateLegacyQuery('"alpha beta').warnings).toHaveLength(2)
    expect(migrateLegacyQuery("O'Brien").query).toBe('"O\'Brien"')
    expect(migrateLegacyQuery("foo\\bar").query).toBe('"foo\\\\bar"')
    expect(migrateLegacyQuery("").query).toBe("date:[* TO *]")
    expect(() => migrateLegacyQuery("from:a from:b")).toThrow("given twice")
  })
})
