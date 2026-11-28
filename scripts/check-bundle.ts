/**
 * Every code entry of `exports` loads from the bundle, under the runtime this runs in (`check:dist` runs under Node
 * and under Bun). cli-base and commander stay outside it: a CLI imports the same installed copy, and a second copy
 * inside the bundle would split cli-base's error classes and commander's `Command` in two.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const PEERS_INSIDE = /node_modules[\\/](?:\.pnpm[\\/])?(?:@wirecat[\\/+]cli-base|commander)\b/

export const checkBundle = async (root: string): Promise<string[]> => {
  const manifest = JSON.parse(readFileSync(join(root, "../package.json"), "utf8")) as {
    exports: Record<string, string | { default?: string }>
  }
  const bundle = join(root, "bundle")
  const loaded: string[] = []
  for (const [key, value] of Object.entries(manifest.exports)) {
    const file = typeof value === "object" ? value.default : undefined
    if (!file?.startsWith("./dist/bundle/")) continue
    const module = await import(pathToFileURL(join(root, "..", file)).href)
    if (Object.keys(module).length === 0) throw new Error(`${key} (${file}) exports nothing`)
    loaded.push(key)
  }
  const chunks = readdirSync(bundle).filter((name) => name.endsWith(".js"))
  const inside = chunks.filter((name) => PEERS_INSIDE.test(readFileSync(join(bundle, name), "utf8")))
  if (inside.length > 0) throw new Error(`dist/bundle has a copy of cli-base or commander: ${inside.join(", ")}`)
  const listed = JSON.parse(readFileSync(join(bundle, "chunks.json"), "utf8")) as string[]
  const missing = listed.filter((chunk) => !chunks.includes(chunk.replace(/^\.\//, "")))
  if (missing.length > 0) throw new Error(`chunks.json names files that are not in dist/bundle: ${missing.join(", ")}`)
  return loaded
}
