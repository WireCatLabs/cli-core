import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { loadSnakeCaseConfig } from "./config-keys.js"

const schema = v.strictObject({
  client_id: v.string(),
  accounts: v.optional(v.record(v.string(), v.strictObject({ sync_mode: v.optional(v.picklist(["full", "recent"])) }))),
})

const load = (contents: unknown) => {
  const path = join(mkdtempSync(join(tmpdir(), "config-keys-")), "config.json")
  writeFileSync(path, JSON.stringify(contents))
  return () => loadSnakeCaseConfig(path, schema, () => ({ client_id: "" }))
}

describe("loadSnakeCaseConfig", () => {
  it("names a missing key, a wrong top level and a value outside the choices", () => {
    expect(load({})).toThrowError(/: client_id is missing$/)
    expect(load("text")).toThrowError(/: the whole file has the wrong type$/)
    expect(load({ client_id: "x", accounts: { work: { sync_mode: "everything-private" } } })).toThrowError(
      /: accounts\.work\.sync_mode has an invalid value$/,
    )
    expect(load({ client_id: "x", accounts: { work: { sync_mode: "everything-private" } } })).not.toThrowError(
      /everything-private/,
    )
  })

  it("names an unknown camelCase key as it is, with no rename", () => {
    expect(load({ clientId: "x" })).toThrowError(/: client_id is missing \(and 1 more problem\)$/)
    expect(load({ clientId: "x" })).not.toThrowError(/rename/)
    expect(load({ client_id: "x", accounts: { work: { syncMode: "full" } } })).toThrowError(
      /: accounts\.work\.syncMode is an unknown setting$/,
    )
  })
})
