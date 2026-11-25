import { describe, expect, it } from "vitest"
import { breakProblems, documented, reasonsTable } from "./reasons-docs.ts"

const reasons = [
  { reason: "item.not-found", code: "not_found", message: "no item | by this id", details: ["id"] },
  { reason: "db.timeout", code: "timeout", message: "the database did not answer" },
]
const page = `intro\n\n<!-- reasons: generated -->\n\n${reasonsTable(reasons)}\n\n<!-- reasons: end -->\n`
const fragment = (heading: string, line: string) => [{ name: "x.md", text: `### ${heading}\n\n- ${line}\n` }]

describe("reasons docs", () => {
  it("lists each reason sorted, with its code and detail keys", () => {
    expect(reasonsTable(reasons).split("\n").slice(2)).toEqual([
      "| `db.timeout` | `timeout` | the database did not answer |  |",
      "| `item.not-found` | `not_found` | no item \\| by this id | `id` |",
    ])
    expect(documented(page)).toEqual(
      new Map([
        ["db.timeout", "timeout"],
        ["item.not-found", "not_found"],
      ]),
    )
  })

  it("refuses a documented reason that is gone or recoded without a fragment", () => {
    const now = [{ ...reasons[0], code: "conflict" }] as typeof reasons
    expect(breakProblems(documented(page), now, [])).toEqual([
      expect.stringMatching(/^`db\.timeout` is gone from REASONS/),
      expect.stringMatching(/^`item\.not-found` changed its code from not_found to conflict/),
    ])
  })

  it("takes the removal once a fragment names it under a break heading, not under another", () => {
    const now = reasons.slice(0, 1)
    expect(breakProblems(documented(page), now, fragment("Removed", "**`db.timeout`** is gone."))).toEqual([])
    expect(breakProblems(documented(page), now, fragment("Changed — may break callers", "`db.timeout`"))).toEqual([])
    expect(breakProblems(documented(page), now, fragment("Fixed", "`db.timeout`"))).toHaveLength(1)
  })
})
