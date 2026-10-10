import { describe, expect, it } from "vitest"
import { executableEnvironment, executableOnPath } from "./executable.js"

describe("Windows executable selection", () => {
  it("ignores the current directory and relative PATH entries, even with a planted command", () => {
    const calls: string[] = []
    const env = { Path: ';.;relative;"C:\\Trusted Tools"', PATHEXT: ".CMD;.EXE" }
    const found = executableOnPath("npm", env, "win32", (path) => {
      calls.push(path)
      return path === "C:\\Trusted Tools\\npm.CMD"
    })
    expect(found).toBe("C:\\Trusted Tools\\npm.CMD")
    expect(calls).toEqual(["C:\\Trusted Tools\\npm.CMD"])
  })

  it("fails closed when only a relative command is available", () => {
    expect(() => executableOnPath("claude", { PATH: ".;relative" }, "win32", () => true)).toThrow(
      "absolute Windows PATH",
    )
  })

  it("uses a fully-qualified command processor for shims", () => {
    expect(executableEnvironment({ ComSpec: "cmd.exe", SystemRoot: "C:\\Windows" }, "win32")).toEqual({
      SystemRoot: "C:\\Windows",
      comspec: "C:\\Windows\\System32\\cmd.exe",
    })
    expect(() => executableEnvironment({ ComSpec: "cmd.exe" }, "win32")).toThrow("absolute ComSpec")
  })

  it("preserves explicit absolute programs and POSIX command behavior", () => {
    expect(executableOnPath("C:\\Tools\\node.exe", {}, "win32")).toBe("C:\\Tools\\node.exe")
    expect(executableOnPath("npm", {}, "linux")).toBe("npm")
    expect(executableEnvironment({ PATH: "/usr/bin" }, "linux")).toEqual({ PATH: "/usr/bin" })
  })
})
