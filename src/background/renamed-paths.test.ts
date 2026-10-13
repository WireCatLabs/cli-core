import { describe, expect, it } from "vitest"
import { currentArgv } from "./renamed-paths.js"

describe("currentArgv", () => {
  it("runs a saved store fetch as messages sync, with or without a profile first", () => {
    expect(currentArgv(["store", "fetch", "7", "--limit", "40"])).toEqual(["messages", "sync", "7", "--limit", "40"])
    expect(currentArgv(["work", "store", "fetch", "--all"])).toEqual(["work", "messages", "sync", "--all"])
  })

  it("leaves every other command alone, even a chat named store", () => {
    expect(currentArgv(["messages", "list", "store", "fetch"])).toEqual(["messages", "list", "store", "fetch"])
    expect(currentArgv(["store", "jobs", "list"])).toEqual(["store", "jobs", "list"])
  })
})
