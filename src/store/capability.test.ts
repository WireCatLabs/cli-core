import { isCliError } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import type { CacheDatabase } from "./driver.js"
import { assertStoreCapable, openCache } from "./open.js"

const withoutFts5: CacheDatabase = {
  exec: () => {
    throw new Error("no such module: fts5")
  },
  prepare: () => ({ run: () => ({ changes: 0 }), get: () => ({ version: "3.49.1" }), all: () => [] }),
  close: () => {},
}

const refusal = (database: CacheDatabase, on: string) => {
  try {
    assertStoreCapable(database, on)
  } catch (error) {
    return error
  }
  throw new Error("expected a refusal")
}

describe("the SQLite capability check", () => {
  it("**passes on the runtime the tests run on**, and leaves nothing behind", async () => {
    const database = await openCache(":memory:")
    assertStoreCapable(database)
    expect(database.prepare("SELECT name FROM temp.sqlite_schema").all()).toEqual([])
    database.close()
  })

  it("**refuses a SQLite without full-text search** with what it found and what to do under Node", () => {
    const error = refusal(withoutFts5, "Node 22.15.0")

    expect(isCliError(error) && error.code).toBe("configuration_error")
    expect((error as Error).message).toBe(
      "the message store needs full-text search that this SQLite (3.49.1, Node 22.15.0) does not have. " +
        "Update Node to 22.16 or newer, or run it under Bun.",
    )
  })

  it("tells a Bun user to run it under Node", () => {
    expect((refusal(withoutFts5, "Bun 1.3.0") as Error).message).toMatch(/Run it under Node 22\.16 or newer instead\.$/)
  })
})
