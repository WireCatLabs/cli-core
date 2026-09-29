import { describe, expect, it } from "vitest"
import { noopLogger } from "./logger.js"

describe("noopLogger", () => {
  it("accepts every level and does nothing", () => {
    for (const level of ["debug", "info", "warn", "error"] as const)
      expect(noopLogger[level]({ event: "x" }, "message")).toBeUndefined()
  })
})
