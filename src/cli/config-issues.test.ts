import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { checkConfigText, issueMessage } from "./index.js"

const file = "/config.json"

// Offsets V8 names where it names one (Node 22.23 and 24.19, 2026-10-25); the rest are where parsing stops.
const BROKEN: [string, string, number, number][] = [
  ["missing comma", '{\n  "a": 1\n  "b": 2\n}', 3, 3],
  ["trailing comma", '{\n  "a": 1,\n}', 3, 1],
  ["unexpected token", '{\n  "a": tru\n}', 2, 8],
  ["unterminated string", '{\n  "a": "abc\n}', 2, 12],
  ["empty file", "", 1, 1],
  ["truncated", '{\n  "a": [1, 2', 2, 13],
  ["extra close", '{"a":1}}', 1, 8],
  ["comment", '{\n  // c\n  "a": 1\n}', 2, 3],
]

const flat = v.strictObject({
  limit: v.optional(v.number()),
  permissions: v.optional(v.record(v.string(), v.picklist(["deny", "allow"]))),
})

describe("checkConfigText", () => {
  it.each(BROKEN)("**places %s** at the line and column parsing stopped, on any runtime", (_, text, line, column) => {
    expect(checkConfigText(text, { file, tool: "app", schema: flat })).toEqual({
      issues: [
        {
          kind: "invalid_json",
          file,
          line,
          column,
          what: `the file is not valid JSON at line ${line}, column ${column}`,
        },
      ],
      config: undefined,
    })
  })

  it("**checks a flat file**: unknown settings, wrong values and permission keys no command checks", () => {
    const text = JSON.stringify({ limit: "x", limitt: 1, permissions: { "messages.send": "allow", "bogus.x": "deny" } })
    const { issues, config } = checkConfigText(text, {
      file,
      tool: "memo",
      schema: flat,
      knownPermissions: new Set(["messages", "messages.send"]),
    })
    expect(issues).toEqual([
      expect.objectContaining({ kind: "invalid_value", key: "limit", fix: "memo config unset limit" }),
      expect.objectContaining({ kind: "unknown_setting", key: "limitt", fix: "memo config unset limitt" }),
      expect.objectContaining({
        kind: "unknown_permission",
        key: "permissions.bogus.x",
        fix: "memo config unset permissions.bogus.x",
      }),
    ])
    expect(issues.some((issue) => "profile" in issue)).toBe(false)
    expect(config).toEqual({ permissions: { "messages.send": "allow", "bogus.x": "deny" } })
    expect(issueMessage(issues, "memo doctor")).toBe(
      "/config.json: setting limit has to be of type number — remove it with `memo config unset limit` " +
        "(and 2 more problems — `memo doctor` lists them all)",
    )
  })

  it("names the profile and section of a file with profiles", () => {
    const profiled = v.strictObject({
      profiles: v.optional(v.record(v.string(), flat)),
      bot: v.optional(v.strictObject({ defaults: v.optional(flat) })),
    })
    const text = JSON.stringify({
      profiles: { work: { permissions: { "bogus.x": "deny" } } },
      bot: { defaults: { colour: 1 } },
    })
    const { issues } = checkConfigText(text, { file, tool: "app", schema: profiled, knownPermissions: new Set() })
    expect(issues.map(({ fix }) => fix)).toEqual([
      "app config unset --defaults --bot colour",
      "app work config unset permissions.bogus.x",
    ])
  })
})
