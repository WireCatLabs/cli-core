/**
 * The `cli` entry loads neither the MCP SDK nor zod: they are about a tenth of its files, and a CLI's `--help`
 * pays for every file the entry reaches. They come through `@wirecat/cli-core/mcp`, imported where MCP is served.
 */
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const HOOK = `import { registerHooks } from "node:module"
registerHooks({ resolve(specifier, context, next) {
  const resolved = next(specifier, context)
  if (/@modelcontextprotocol|\\/zod\\//.test(resolved.url)) process.stdout.write(resolved.url + "\\n")
  return resolved
} })`

export const checkCliEntry = (root: string): void => {
  if (process.versions.bun) return
  const entry = pathToFileURL(join(root, "cli/index.js")).href
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(HOOK)}`,
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(entry)})`,
    ],
    { encoding: "utf8" },
  )
  if (run.status !== 0) throw new Error(`importing dist/cli/index.js failed: ${run.stderr}`)
  const loaded = run.stdout.trim()
  if (loaded)
    throw new Error(`dist/cli/index.js loads the MCP SDK or zod:\n${loaded.split("\n").slice(0, 5).join("\n")}`)
}
