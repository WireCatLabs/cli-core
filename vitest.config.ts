import { defineConfig } from "vitest/config"

export default defineConfig({
  // Oxc's tsconfig loader does not follow package exports; TypeScript still checks the full project configs.
  tsconfig: "./node_modules/@wirecat/cli-base/config/tsconfig.base.json",
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    setupFiles: ["@wirecat/cli-base/testing/setup", "src/testing/sandbox.ts", "src/testing/fresh-store.ts"],
    globals: false,
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
        // stdin, argv and an exit code around parityProblems, which the parity tests cover.
        "src/parity/bin.ts",
      ],
      reporter: ["text-summary", "json-summary", "html"],
      // A little under what the suite reaches (2026-09-29), so coverage can rise and not fall.
      thresholds: {
        lines: 99,
        statements: 90,
        functions: 89,
        branches: 77,
        perFile: { lines: 50 },
      },
    },
  },
})
