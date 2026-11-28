/**
 * `tsc` emits only what it compiles, so the vendored Snowball JavaScript, the gzipped Russian dictionary and their
 * licences are copied into `dist/` beside the modules that read them.
 *
 *   node scripts/copy-snowball.ts          (part of `pnpm build`)
 */
import { cpSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dirname, "..")
cpSync(join(root, "src/search/snowball"), join(root, "dist/search/snowball"), {
  recursive: true,
  filter: (source) => !source.includes("samples") && !source.endsWith(".d.ts"),
})
cpSync(join(root, "src/search/dictionaries"), join(root, "dist/search/dictionaries"), { recursive: true })
