import { describe, expect, it } from "vitest"
import { BUILT_IN_PURPOSE_CONFIG, purposeList, purposeRead, purposesOf } from "./project-purposes.js"

const HRB = { ref: "project:4", key: "HRB" }

describe("purposesOf", () => {
  it("reads the built-in default, work, when nothing is asked and no config is given", () => {
    const chosen = purposesOf(undefined)
    expect(chosen).toEqual(new Set(["work"]))
    expect(purposeRead(chosen, null)).toBe(true)
    expect(purposeRead(chosen, "sales")).toBe(false)
  })

  it("takes a project's own defaults over the config's, by key or by ref", () => {
    const config = { ...BUILT_IN_PURPOSE_CONFIG, projects: { HRB: ["work", "sales"], "project:9": ["support"] } }
    expect(purposesOf([], config, HRB)).toEqual(new Set(["work", "sales"]))
    expect(purposesOf([], config, { ref: "project:9", key: "OTHER" })).toEqual(new Set(["support"]))
    expect(purposesOf([], config, { ref: "project:5", key: "NEW" })).toEqual(new Set(["work"]))
  })

  it("reads every purpose with all, an unlisted one too, and refuses all next to another", () => {
    const all = purposesOf(["all"])
    expect(purposeRead(all, "invoices")).toBe(true)
    expect(() => purposesOf(["all", "work"])).toThrow(/give it alone/)
  })

  it("refuses an unknown purpose and lists the configured ones", () => {
    const config = { purposes: ["work", "leads"], defaults: ["work"] }
    expect(() => purposesOf(["sales"], config)).toThrow(
      "unknown purpose sales; the configured ones are work, leads, or all",
    )
    expect(purposesOf(["leads"], config)).toEqual(new Set(["leads"]))
  })

  it("splits a comma list and joins repeated flags", () => {
    expect(purposeList("sales, work", ["other"])).toEqual(["other", "sales", "work"])
  })
})
