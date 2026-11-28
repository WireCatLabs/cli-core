import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { developerOnly, pairProblems } from "./release-pair.ts"

const unpacked = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "release-pair-"))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const manifest = (version: string) => `{\n  "name": "@wirecat/cli-core",\n  "version": "${version}"\n}\n`
const runtime = { "dist/index.js": "export {}\n//# sourceMappingURL=index.js.map\n", "README.md": "# cli-core\n" }
const types = { "dist/index.d.ts": "export {}\n", "dist/index.d.ts.map": "{}", "dist/index.js.map": "{}" }
const lean = (extra: Record<string, string> = {}) =>
  unpacked({ ...runtime, "package.json": manifest("2.1.0"), ...extra })
const dev = (extra: Record<string, string> = {}) =>
  unpacked({ ...runtime, ...types, "src/index.ts": "export {}\n", "package.json": manifest("2.1.0-dev"), ...extra })

describe("the release pair", () => {
  it("passes when the runtime files are the same bytes and only -dev has types, maps and src", () => {
    expect(pairProblems(lean(), dev(), "2.1.0")).toEqual([])
  })

  it("fails on a runtime file that differs, or that only one of the two ships", () => {
    expect(pairProblems(lean({ "dist/index.js": "export {}\n" }), dev({ "dist/extra.js": "" }), "2.1.0")).toEqual([
      "only 2.1.0-dev ships dist/extra.js",
      "dist/index.js differs between 2.1.0 and 2.1.0-dev",
    ])
  })

  it("fails when users would get a type file, or the -dev twin has none", () => {
    const noTypes = unpacked({ ...runtime, "package.json": manifest("2.1.0-dev") })
    expect(pairProblems(lean({ "dist/a.d.ts": "" }), noTypes, "2.1.0")).toEqual([
      "2.1.0 ships dist/a.d.ts",
      "2.1.0-dev has no dist/index.d.ts",
    ])
  })

  it("fails when package.json differs in more than the version", () => {
    const changed = dev({ "package.json": manifest("2.1.0-dev").replace("cli-core", "cli-kore") })
    expect(pairProblems(lean(), changed, "2.1.0")).toEqual(["package.json differs in more than the version"])
  })

  it("leaves out of the user package exactly the types, the maps and src/", () => {
    expect(
      ["dist/a.d.ts", "dist/a.d.ts.map", "dist/a.js.map", "src/a.ts", "dist/a.js", "schemas/a.json"].filter(
        developerOnly,
      ),
    ).toEqual(["dist/a.d.ts", "dist/a.d.ts.map", "dist/a.js.map", "src/a.ts"])
  })
})
