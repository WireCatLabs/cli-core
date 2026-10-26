import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { privateFiles } from "./private-files.js"

describe("privateFiles", () => {
  it.skipIf(process.platform === "win32")("gives a fix that runs as written for a path with a quote in it", () => {
    const folder = mkdtempSync(join(tmpdir(), "it's private-"))
    const file = join(folder, "config.json")
    writeFileSync(file, "{}")
    chmodSync(file, 0o644)
    chmodSync(folder, 0o775)

    const found = privateFiles({ files: [file], dirs: [folder] })
    if (!found.checked) throw new Error("expected a check")
    expect(found.problems.map(({ path, mode, want }) => ({ path, mode, want }))).toEqual([
      { path: file, mode: "0644", want: "0600" },
      { path: folder, mode: "0775", want: "0700" },
    ])

    for (const { fix } of found.problems) execFileSync("sh", ["-c", fix])
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(folder).mode & 0o777).toBe(0o700)
    expect(privateFiles({ files: [file], dirs: [folder] })).toEqual({ checked: true, ok: true, problems: [] })
  })

  it.skipIf(process.platform === "win32")("suggests no file mode for a folder where a file should be", () => {
    const folder = mkdtempSync(join(tmpdir(), "private-"))
    const config = join(folder, "config.json")
    mkdirSync(config)
    chmodSync(config, 0o755)
    chmodSync(folder, 0o700)
    expect(privateFiles({ files: [config], dirs: [folder] })).toEqual({ checked: true, ok: true, problems: [] })
  })

  it("does not check on Windows, which has no Unix file modes", () => {
    const folder = mkdtempSync(join(tmpdir(), "private-"))
    expect(privateFiles({ files: [join(folder, "config.json")], dirs: [folder] }, "win32")).toEqual({
      checked: false,
      reason: "Windows has no Unix file modes",
    })
  })
})
