/**
 * The last step of `pnpm build`: bundles what `exports` names into `dist/bundle/`, so a CLI loads cli-core from this
 * package in a few files instead of carrying its own copy (docs/dev/plans/2026-11-28-shared-cli-core.md).
 * What `./start` loads statically is one chunk and the rest of what `.` loads another; `./mcp`, `./documents`,
 * `./mail` and `./testing` stay apart, since a CLI's start does not load them. The unbundled `.js` stay: they are the place `import.meta.url` names, and
 * the embedding process is started from `dist/embeddings/child.js`.
 *
 *   node scripts/bundle-dist.ts          (part of `pnpm build`)
 */
import { join } from "node:path"
import { bundlePackage } from "@wirecat/cli-base/dev"

const { problems, chunks } = await bundlePackage({
  root: join(import.meta.dirname, ".."),
  merge: [["start"], ["index"]],
})
if (problems.length > 0) {
  console.error(problems.join("\n"))
  process.exit(1)
}
console.log(`dist/bundle: ${chunks.length} files for ./preload`)
