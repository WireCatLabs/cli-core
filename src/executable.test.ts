import { describe, expect, it } from "vitest"
import { executableEnvironment, executableOnPath } from "./executable.js"

describe("Windows executable selection", () => {
  it("supports relative PATH entries and explicit relative commands", () => {
    const env = { Path: "relative;C:\\Trusted Tools", PATHEXT: ".CMD;.EXE" }
    expect(executableOnPath("npm", env, "win32", (path) => path === "relative\\npm.CMD")).toBe("relative\\npm.CMD")
    expect(executableOnPath(".\\tools\\npm.cmd", env, "win32")).toBe(".\\tools\\npm.cmd")
    expect(executableOnPath("claude", {}, "win32", () => false)).toBe("claude")
  })

  it("preserves custom command processors and tolerates sanitized environments", () => {
    expect(executableEnvironment({ ComSpec: "cmd.exe" }, "win32")).toEqual({ comspec: "cmd.exe" })
    expect(executableEnvironment({ SystemRoot: "C:\\Windows" }, "win32")).toEqual({
      SystemRoot: "C:\\Windows",
      comspec: "C:\\Windows\\System32\\cmd.exe",
    })
    expect(executableEnvironment({}, "win32")).toEqual({})
  })

  it("preserves explicit absolute programs and POSIX command behavior", () => {
    expect(executableOnPath("C:\\Tools\\node.exe", {}, "win32")).toBe("C:\\Tools\\node.exe")
    expect(executableOnPath("npm", {}, "linux")).toBe("npm")
    expect(executableEnvironment({ PATH: "/usr/bin" }, "linux")).toEqual({ PATH: "/usr/bin" })
  })
})
