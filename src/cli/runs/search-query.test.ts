import { expect, it } from "vitest"
import { runSearchFilter } from "./search-query.js"

it("combines literal terms and run status with native start-time bounds", () => {
  expect(runSearchFilter(["timeout status:failed started_at:[2026-10-01T00:00:00Z TO 2026-10-02T00:00:00Z]"])).toEqual({
    terms: ["timeout"],
    status: "failed",
    since: "2026-10-01T00:00:00.000Z",
    until: "2026-10-02T00:00:00.000Z",
  })
})
it("refuses repeated time windows and OR before reading diagnostic files", () => {
  expect(() => runSearchFilter(["started_at:today started_at:yesterday"])).toThrow("only once")
  expect(() => runSearchFilter(["started_at:today OR status:failed"])).toThrow("joined by AND")
})
