import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { checkConfigText, issueMessage, readConfigFile, readConfigText, withoutSetting } from "./index.js"

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

const account = v.strictObject({ name: v.string(), address: v.optional(v.string()) })
const memo = v.strictObject({
  mail: v.optional(v.strictObject({ accounts: v.optional(v.array(account)) })),
  notes: v.optional(v.strictObject({ folder: v.optional(v.string()) })),
  lists: v.optional(v.array(v.array(account))),
  permissions: v.optional(v.record(v.string(), v.picklist(["deny", "allow"]))),
})
const memoCheck = (raw: unknown) =>
  checkConfigText(JSON.stringify(raw), { file, tool: "memo", schema: memo, knownPermissions: new Set(["mail"]) })

describe("a setting inside a list item", () => {
  it("**is removed alone**, so the rest loads and every issue is found in one pass", () => {
    const { issues, config } = memoCheck({
      mail: { accounts: [{ name: "home", address: "a@example.test", colour: "x" }] },
      notes: { folder: "/notes" },
      permissions: { "auto.start": "deny" },
    })
    expect(issues).toEqual([
      expect.objectContaining({
        kind: "unknown_setting",
        key: "mail.accounts.0.colour",
        fix: "memo config unset mail.accounts.0.colour",
      }),
      expect.objectContaining({
        kind: "unknown_permission",
        key: "permissions.auto.start",
        fix: "memo config unset permissions.auto.start",
      }),
    ])
    expect(config).toEqual({
      mail: { accounts: [{ name: "home", address: "a@example.test" }] },
      notes: { folder: "/notes" },
      permissions: { "auto.start": "deny" },
    })
  })

  it("**reaches into nested lists**, and names an item after a dropped one by its place in the file", () => {
    const { issues, config } = memoCheck({
      lists: [[{ name: "a", bad: 1 }], [5, { name: "b", colour: 1 }]],
      mail: { accounts: [7, { name: "c", colour: 1 }] },
    })
    expect(issues.map(({ kind, key }) => `${kind} ${key}`).sort()).toEqual([
      "invalid_value lists.1.0",
      "invalid_value mail.accounts.0",
      "unknown_setting lists.0.0.bad",
      "unknown_setting lists.1.1.colour",
      "unknown_setting mail.accounts.1.colour",
    ])
    expect(config).toEqual({ lists: [[{ name: "a" }], [{ name: "b" }]], mail: { accounts: [{ name: "c" }] } })
  })

  it("**is what `withoutSetting` removes**, leaving the item and the others where they were", () => {
    const raw = {
      mail: { accounts: [{ name: "home", colour: "x" }, { name: "work" }] },
      permissions: { "a.b": "deny" },
    }
    expect(withoutSetting(raw, "mail.accounts.0.colour")).toEqual({
      config: { mail: { accounts: [{ name: "home" }, { name: "work" }] }, permissions: { "a.b": "deny" } },
      removed: true,
    })
    expect(withoutSetting(raw, "mail.accounts.1.name").config).toEqual({
      mail: { accounts: [{ name: "home", colour: "x" }, {}] },
      permissions: { "a.b": "deny" },
    })
    expect(withoutSetting(raw, "permissions.a.b").config).toEqual({ mail: raw.mail })
    expect(withoutSetting(raw, "mail.accounts.4.name")).toEqual({ config: raw, removed: false })
  })
})

describe("a file that is not a config object", () => {
  it.each(["[]", "[1]", '"text"', "null", "3"])("**refuses %s as a whole**, with no key and no fix", (text) => {
    expect(checkConfigText(text, { file, tool: "app", schema: flat })).toEqual({
      issues: [{ kind: "invalid_value", file, what: "the file must hold a JSON object" }],
      config: undefined,
    })
  })

  it("**reports a folder at the path, or a file it may not read**, and no file as none", () => {
    const root = mkdtempSync(join(tmpdir(), "config-read-"))
    expect(readConfigText(join(root, "absent.json"))).toEqual({ text: undefined })
    expect(readConfigFile(join(root, "absent.json"))).toEqual({ raw: undefined })
    mkdirSync(join(root, "folder.json"))
    expect(readConfigFile(join(root, "folder.json"))).toEqual({
      issue: { kind: "invalid_value", file: join(root, "folder.json"), what: "the path is a folder, not a file" },
    })
    const locked = join(root, "locked.json")
    writeFileSync(locked, "{}")
    chmodSync(locked, 0o000)
    // root reads any file, so the refusal only shows for an ordinary user.
    if (process.getuid?.() !== 0)
      expect(readConfigText(locked)).toEqual({
        issue: { kind: "invalid_value", file: locked, what: "the file could not be read" },
      })
    chmodSync(locked, 0o600)
  })
})
