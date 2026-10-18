import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import { quietSqliteWarning } from "./sqlite-warning.js"

const fakeHost = () => {
  const seen: unknown[][] = []
  const host = { emitWarning: (...args: unknown[]) => void seen.push(args) } as Pick<NodeJS.Process, "emitWarning">
  return { host, seen }
}

describe("quietSqliteWarning", () => {
  it("drops only the SQLite experimental warning", () => {
    const { host, seen } = fakeHost()
    quietSqliteWarning(host)
    host.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning")
    host.emitWarning(Object.assign(new Error("SQLite is an experimental feature"), { name: "ExperimentalWarning" }))
    host.emitWarning("SQLite is an experimental feature", { type: "ExperimentalWarning" })
    host.emitWarning("VM modules are an experimental feature", "ExperimentalWarning")
    host.emitWarning("SQLite is an experimental feature", "DeprecationWarning")
    expect(seen.map(([warning]) => warning)).toEqual([
      "VM modules are an experimental feature",
      "SQLite is an experimental feature",
    ])
  })

  it("wraps a host once however often it is called", () => {
    const { host } = fakeHost()
    quietSqliteWarning(host)
    const wrapped = host.emitWarning
    quietSqliteWarning(host)
    expect(host.emitWarning).toBe(wrapped)
  })

  it("keeps stderr clean when node:sqlite loads after it", () => {
    const script = `
      const { quietSqliteWarning } = await import(${JSON.stringify(new URL("./sqlite-warning.ts", import.meta.url).href)})
      quietSqliteWarning()
      const { DatabaseSync } = await import("node:sqlite")
      new DatabaseSync(":memory:").close()
    `
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      encoding: "utf8",
    })
    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain("SQLite is an experimental feature")
  })
})
