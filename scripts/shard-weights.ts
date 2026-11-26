/**
 * Writes test/shard-weights.json, the milliseconds each test file took, from a Vitest JSON report. vitest.config.ts
 * splits the files between the CI shards by these weights. A file missing from it counts as the median, so a stale
 * list only makes the shards a little uneven.
 *
 *   pnpm test:slow && node scripts/shard-weights.ts coverage/tests.json
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

type Report = { testResults: { name: string; startTime: number; endTime: number }[] }

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const input = process.argv[2]
if (!input) {
  console.error("usage: node scripts/shard-weights.ts <vitest JSON report>")
  process.exit(2)
}
const report = JSON.parse(readFileSync(input, "utf8")) as Report
const weights = Object.fromEntries(
  report.testResults
    .map(
      (file) =>
        [
          relative(root, file.name).split("\\").join("/"),
          Math.max(0, Math.round(file.endTime - file.startTime)),
        ] as const,
    )
    .sort(([a], [b]) => a.localeCompare(b)),
)
writeFileSync(join(root, "test/shard-weights.json"), `${JSON.stringify(weights, null, 2)}\n`)
console.log(`test/shard-weights.json: ${Object.keys(weights).length} files`)
