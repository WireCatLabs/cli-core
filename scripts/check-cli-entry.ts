/**
 * A CLI's `--help` pays for every byte of the bundle that `.` loads, and every command pays for what `./start` loads
 * before the program. A module that slips into the wrong chunk shows here first: the MCP SDK and zod (1.1 MB) belong to
 * `./mcp`, loaded where MCP is served, and `./start` must not pull in the chunk of `.`.
 */
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

/** Measured 2026-11-28: `.` loads 10.9 MB of the bundle, `./start` 0.02 MB. */
export const ENTRY_BYTES = { index: 11_300_000, start: 200_000 }

const HOOK = (bundle: string) => `import { registerHooks } from "node:module"
let bytes = 0
registerHooks({ load(url, context, next) {
  const loaded = next(url, context)
  if (url.startsWith(${JSON.stringify(bundle)})) bytes += loaded.source?.length ?? 0
  if (/@modelcontextprotocol|\\/zod\\//.test(url)) process.stderr.write("outside: " + url + "\\n")
  return loaded
} })
process.on("exit", () => process.stdout.write(String(bytes)))`

export const entryBytes = (root: string, entry: keyof typeof ENTRY_BYTES): number => {
  const bundle = pathToFileURL(join(root, "bundle/")).href
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(HOOK(bundle))}`,
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(new URL(`${entry}.js`, bundle).href)})`,
    ],
    { encoding: "utf8" },
  )
  if (run.status !== 0) throw new Error(`importing dist/bundle/${entry}.js failed: ${run.stderr}`)
  if (run.stderr.includes("outside: "))
    throw new Error(`dist/bundle/${entry}.js loads the MCP SDK or zod:\n${run.stderr}`)
  return Number(run.stdout.trim())
}

export const checkEntries = (root: string): void => {
  if (process.versions.bun) return
  for (const [entry, most] of Object.entries(ENTRY_BYTES) as [keyof typeof ENTRY_BYTES, number][]) {
    const bytes = entryBytes(root, entry)
    if (!(bytes > 0 && bytes <= most))
      throw new Error(`dist/bundle/${entry}.js loads ${bytes} bytes of the bundle, more than ${most}`)
  }
}
