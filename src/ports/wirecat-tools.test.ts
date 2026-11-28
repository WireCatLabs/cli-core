import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { WIRECAT_TOOLS } from "./wirecat-tools.js"

const SRC = fileURLToPath(new URL("..", import.meta.url))

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "testing" ? [] : sources(path)
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : []
  })

// Stored ids (`memo:bulk`, `memo-scan`), memo's unit names and its old folder stay until store version 79 and wcat's
// first start move them; `search all`'s frozen template is the text CLIs reviewed before the split. The migrations
// are history: version 79's statements name the old `memo` values they rename.
const KEPT = /\bmemo[:\-|*]|cli-memo/g
const FROZEN = new Set(["cli/contract-templates.ts", "store/sqlite/migrations.generated.ts"])

describe("WireCat's tools", () => {
  it("name wcat and files, never memo, in what a person or an agent reads", () => {
    const named = sources(SRC).flatMap((path) => {
      const file = relative(SRC, path)
      if (FROZEN.has(file)) return []
      return readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, at) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return []
          return /\bmemo\b/.test(line.replace(KEPT, "")) ? [`${file}:${at + 1}`] : []
        })
    })
    expect(named).toEqual([])
    expect(WIRECAT_TOOLS.map((tool) => tool.command)).toEqual(expect.arrayContaining(["wcat", "files"]))
  })
})
