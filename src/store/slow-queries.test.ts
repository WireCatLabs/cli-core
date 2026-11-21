import { afterEach, describe, expect, it, vi } from "vitest"
import { queryShape } from "./slow-queries.js"
import { openSqlite } from "./sqlite/open.js"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("slow statements", () => {
  it("**prints each statement past `WIRECAT_SQL_SLOW_MS`** with its time and rows, and its shape without values", async () => {
    vi.stubEnv("WIRECAT_SQL_SLOW_MS", "0")
    const printed = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const { database } = await openSqlite(":memory:")

    database.prepare("SELECT 'the owner''s words' AS text, 42 AS n UNION ALL SELECT 'more', 7").all()

    expect(printed.mock.calls.map(([line]) => String(line))).toContainEqual(
      expect.stringMatching(/^sql \d+ ms, 2 rows: SELECT \? AS text, \? AS n UNION ALL SELECT \?, \?\n$/),
    )
    database.close()
  })

  it("prints nothing without it", async () => {
    const printed = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const { database } = await openSqlite(":memory:")

    database.prepare("SELECT 1").all()

    expect(printed.mock.calls.filter(([line]) => String(line).startsWith("sql "))).toEqual([])
    database.close()
  })

  it("keeps names with digits whole", () => {
    expect(queryShape("SELECT x FROM t2 WHERE id IN (1, 2)\n  AND v = 3.5")).toBe(
      "SELECT x FROM t2 WHERE id IN (?, ?) AND v = ?",
    )
  })
})
