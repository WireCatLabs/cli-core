import { CliError } from "@wirecat/cli-base"
import { describe, expect, it } from "vitest"
import { runProgram, thisMachine } from "./system.js"

describe("runProgram", () => {
  it("answers the exit code and both streams", async () => {
    const ran = await runProgram(
      [process.execPath, "-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"],
      process.env,
    )
    expect(ran).toEqual({ code: 3, stdout: "out", stderr: "err" })
  })

  it("refuses a program this machine does not have", async () => {
    await expect(runProgram(["no-such-program-here"], process.env)).rejects.toBeInstanceOf(CliError)
  })
})

describe("thisMachine", () => {
  it("names this node and this process's user", async () => {
    const system = thisMachine()
    expect(system.platform).toBe(process.platform)
    expect(system.entry[0]).toBe(process.execPath)
    expect(system.uid).toBe(process.getuid?.() ?? 0)
    await expect(system.pause()).resolves.toBeUndefined()
  })
})
