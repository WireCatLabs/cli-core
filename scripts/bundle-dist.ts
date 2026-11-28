/**
 * The last step of `pnpm build`: bundles what `exports` names into `dist/bundle/`, so a CLI loads cli-core from this
 * package in a few files instead of carrying its own copy (docs/dev/plans/2026-11-28-shared-cli-core.md).
 * What `./start` loads statically is one chunk and the rest of what `.` loads another; `./mcp`, `./documents`,
 * `./mail` and `./testing` stay apart, since a CLI's start does not load them.
 *
 * A bundled module still names its tsc file through `import.meta.url`, but only as a place: the files beside it are
 * found, the `.js` itself is never read. Only the files started by path run unbundled: the embedding process and
 * the package's bins. `dist/by-path.json` lists them with everything they import, and `scripts/release-pair.ts`
 * leaves every other unbundled `.js` out of the package users get.
 *
 *   node scripts/bundle-dist.ts          (part of `pnpm build`)
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { bundlePackage } from "@wirecat/cli-base/dev"
import { build } from "esbuild"

const root = join(import.meta.dirname, "..")
const { problems, chunks } = await bundlePackage({
  root,
  merge: [["start"], ["index"]],
})
if (problems.length > 0) {
  console.error(problems.join("\n"))
  process.exit(1)
}
console.log(`dist/bundle: ${chunks.length} files for ./preload`)

// src/embeddings/process.ts spawns child.js by its path.
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bin?: Record<string, string> }
const started = ["dist/embeddings/child.js", ...Object.values(manifest.bin ?? {})].sort()
const { metafile } = await build({
  absWorkingDir: root,
  entryPoints: started,
  bundle: true,
  write: false,
  outdir: "by-path",
  platform: "node",
  format: "esm",
  packages: "external",
  metafile: true,
  logLevel: "silent",
})
const keep = Object.keys(metafile.inputs)
  .filter((path) => path.startsWith("dist/") && path.endsWith(".js"))
  .sort()
writeFileSync(join(root, "dist/by-path.json"), `${JSON.stringify({ started, keep }, null, 2)}\n`)
console.log(`dist/by-path.json: ${started.length} files started by path, ${keep.length} unbundled files kept`)
