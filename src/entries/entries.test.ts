import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const here = import.meta.dirname
const facades = readdirSync(here).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))

// `export *` silently drops a name two of its modules export as different values, and the bundle keeps the gap.
// tsc catches the same for types (TS2308); this catches it for values.
describe.each(facades)("the %s entry", (facade) => {
  const source = readFileSync(join(here, facade), "utf8")
  const modules = [...source.matchAll(/^export \* from "([^"]+)"/gm)].map(([, from]) => from ?? "")
  const chosen = new Set(
    [...source.matchAll(/^export (?:type )?\{([^}]*)\}/gm)].flatMap(([, list = ""]) =>
      list.split(",").map(
        (item) =>
          item
            .trim()
            .split(/\s+as\s+/)
            .pop() ?? "",
      ),
    ),
  )

  it("merges modules that export no name twice with different values", async () => {
    const owners = new Map<string, { from: string; value: unknown }>()
    const clashes: string[] = []
    for (const from of modules) {
      const module: Record<string, unknown> = await import(join(here, from))
      for (const [name, value] of Object.entries(module)) {
        const first = owners.get(name)
        if (first === undefined) owners.set(name, { from, value })
        else if (first.value !== value && !chosen.has(name)) clashes.push(`${name}: ${first.from} and ${from}`)
      }
    }
    expect(clashes).toEqual([])
  })
})
