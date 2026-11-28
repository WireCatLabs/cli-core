/**
 * Bundles the pure-JavaScript libraries cli-core runs into `dist/bundled/`, over what `tsc` wrote: the MCP SDK
 * with zod, LiquidJS, tldts and psl. Installed from npm they take about 25 MB; bundled, under 1 MB. Each file in `src/bundled/` is one entry, so a library is in dist once and loads only when a
 * module that uses it does. Their notices are in THIRD_PARTY_NOTICES.
 *
 *   node scripts/bundle-libraries.ts          (part of `pnpm build`)
 */
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { build } from "esbuild"

const root = join(import.meta.dirname, "..")
const source = join(root, "src/bundled")
await build({
  entryPoints: readdirSync(source)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(source, name)),
  outdir: join(root, "dist/bundled"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // LiquidJS lists its CommonJS build as `main`, whose `require("fs")` an ES module bundle cannot run.
  mainFields: ["module", "main"],
  minify: true,
  // Error classes are told apart by name in messages and logs.
  keepNames: true,
  logLevel: "warning",
})
