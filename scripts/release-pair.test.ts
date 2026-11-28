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
const byPath = JSON.stringify({
  started: ["dist/embeddings/child.js"],
  keep: ["dist/embeddings/child.js", "dist/embeddings/embed.js"],
})
const runtime = {
  "dist/bundle/index.js": "export {}\n",
  "dist/embeddings/child.js": 'import "./embed.js"\n',
  "dist/embeddings/embed.js": "export {}\n",
  "dist/by-path.json": byPath,
  "README.md": "# cli-core\n",
}
const types = {
  "dist/index.js": "export {}\n//# sourceMappingURL=index.js.map\n",
  "dist/index.d.ts": "export {}\n",
  "dist/index.d.ts.map": "{}",
  "dist/index.js.map": "{}",
}
const lean = (extra: Record<string, string> = {}) =>
  unpacked({ ...runtime, "package.json": manifest("2.1.0"), ...extra })
const dev = (extra: Record<string, string> = {}) =>
  unpacked({ ...runtime, ...types, "src/index.ts": "export {}\n", "package.json": manifest("2.1.0-dev"), ...extra })

describe("the release pair", () => {
  it("passes when the runtime files are the same bytes and only -dev has types, maps, src and unbundled .js", () => {
    expect(pairProblems(lean(), dev(), "2.1.0")).toEqual([])
  })

  it("fails on a runtime file that differs, or that only one of the two ships", () => {
    expect(
      pairProblems(lean({ "dist/bundle/index.js": "export {}\n\n" }), dev({ "dist/bundle/extra.js": "" }), "2.1.0"),
    ).toEqual(["only 2.1.0-dev ships dist/bundle/extra.js", "dist/bundle/index.js differs between 2.1.0 and 2.1.0-dev"])
  })

  it("fails when users would get an unbundled .js nothing starts, or lack one that is started by path", () => {
    const { "dist/embeddings/embed.js": _, ...withoutEmbed } = runtime
    const missing = unpacked({ ...withoutEmbed, "package.json": manifest("2.1.0") })
    expect(pairProblems(lean({ "dist/index.js": "export {}\n" }), dev(), "2.1.0")).toEqual([
      "2.1.0 ships dist/index.js",
    ])
    expect(pairProblems(missing, dev(), "2.1.0")).toEqual(["only 2.1.0-dev ships dist/embeddings/embed.js"])
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

  it("leaves out of the user package exactly the types, the maps, src/ and the unbundled .js nothing starts", () => {
    const paths = [
      "dist/a.d.ts",
      "dist/a.d.ts.map",
      "dist/a.js.map",
      "src/a.ts",
      "dist/a.js",
      "dist/embeddings/child.js",
      "dist/bundle/index.js",
      "dist/search/dictionaries/russian/index.dic.gz",
      "schemas/a.json",
    ]
    expect(paths.filter(developerOnly(new Set(["dist/embeddings/child.js"])))).toEqual([
      "dist/a.d.ts",
      "dist/a.d.ts.map",
      "dist/a.js.map",
      "src/a.ts",
      "dist/a.js",
    ])
  })
})
