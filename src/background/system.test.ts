import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

  it("keeps the script's linked path, which a package manager's upgrade repoints, not the versioned folder", () => {
    const root = mkdtempSync(join(tmpdir(), "entry-"))
    mkdirSync(join(root, "pkg-1.0.0"))
    writeFileSync(join(root, "pkg-1.0.0", "cli.js"), "")
    symlinkSync(join(root, "pkg-1.0.0"), join(root, "current"))
    const before = process.argv[1]
    process.argv[1] = join(root, "current", "cli.js")
    try {
      expect(thisMachine().entry[1]).toBe(join(root, "current", "cli.js"))
    } finally {
      process.argv[1] = before as string
    }
  })
})
