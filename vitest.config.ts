import { readFileSync } from "node:fs"
import { relative } from "node:path"
import { defineConfig } from "vitest/config"
import { BaseSequencer, type TestSpecification } from "vitest/node"

const weights: Record<string, number> = JSON.parse(
  readFileSync(new URL("./test/shard-weights.json", import.meta.url), "utf8"),
)
const known = Object.values(weights).sort((a, b) => a - b)
const median = known[Math.floor(known.length / 2)] ?? 1

// Vitest shards by a hash of each path, the same number of files each: the store's slow files landed 1,002 s of tests
// on one shard and 626 s on the other (2026-11-26). Heaviest first onto the lighter shard evens them out; the order
// is fixed by weight and path, so every shard computes the same split. `node scripts/shard-weights.ts` refreshes it.
class WeightedSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard ?? { index: 1, count: 1 }
    const root = this.ctx.config.root
    const weighed = files.map((spec) => {
      const path = relative(root, spec.moduleId).split("\\").join("/")
      return { spec, path, weight: weights[path] ?? median }
    })
    weighed.sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const load = Array.from({ length: count }, () => 0)
    const mine: TestSpecification[] = []
    for (const file of weighed) {
      let lightest = 0
      for (let shard = 1; shard < count; shard++) if ((load[shard] ?? 0) < (load[lightest] ?? 0)) lightest = shard
      load[lightest] = (load[lightest] ?? 0) + file.weight
      if (lightest === index - 1) mine.push(file.spec)
    }
    return mine
  }
}

export default defineConfig({
  // Oxc's tsconfig loader does not follow package exports; TypeScript still checks the full project configs.
  tsconfig: "./node_modules/@wirecat/cli-base/config/tsconfig.base.json",
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    globalSetup: ["src/testing/migrated-store.ts"],
    setupFiles: ["@wirecat/cli-base/testing/setup", "src/testing/sandbox.ts", "src/testing/fresh-store.ts"],
    globals: false,
    sequence: { sequencer: WeightedSequencer },
    // Drizzle from node_modules reads its 290 KB package.json for each of its 72 modules: about 340 ms in every
    // test file, a quarter of the suite's CPU (2026-10-18). Bundled once, like dist does, it loads in a few ms.
    deps: {
      optimizer: {
        ssr: { enabled: true, include: ["drizzle-orm", "drizzle-orm/sqlite-core", "drizzle-orm/node-sqlite"] },
      },
    },
    // Agents run suites side by side on 24 cores; one worker per core ran the machine out of memory (2026-10-11).
    maxWorkers: 4,
    // Several sessions run suites on one machine; at load 70 an ordinary store test takes 5–7 s (2026-10-11).
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/testing/**",
        // bun:sqlite does not exist under Node; `pnpm smoke:bun` runs this driver instead.
        "src/store/drivers/bun-sqlite.ts",
        // Declarations whose callbacks drizzle-kit runs, in its own process; the baseline test checks its output.
        "src/store/sqlite/schema.ts",
        // Run only with real worker threads, from dist; `pnpm check:dist` drives two of them under Node and Bun.
        "src/embeddings/worker.ts",
        "src/embeddings/workers.ts",
        // A child process run from dist; `pnpm check:dist` drives it under Node and Bun.
        "src/embeddings/child.ts",
        "src/embeddings/process.ts",
        // Reroutes the process's own streams; command-server.test.ts drives it in a spawned CLI.
        "src/cli/command-server-entry.ts",
        // stdin, argv and an exit code around parityProblems, which the parity tests cover.
        "src/parity/bin.ts",
      ],
      reporter: ["text-summary", "json-summary", "html"],
      // A little under what the suite reaches (2026-09-29), so coverage can rise and not fall.
      thresholds: {
        lines: 92,
        statements: 90,
        functions: 89,
        branches: 77,
        perFile: { lines: 50 },
      },
    },
  },
})
