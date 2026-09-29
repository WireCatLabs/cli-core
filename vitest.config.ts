import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    globals: false,
    // Outside src/: src/testing is a published subpath, and everything under src/ ships in dist/.
    setupFiles: ["test/sandbox.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text-summary", "json-summary", "html"],
      // A little under what the suite reaches (2026-09-29), so coverage can rise and not fall.
      thresholds: {
        lines: 94,
        statements: 92,
        functions: 90,
        branches: 81,
        perFile: { lines: 50 },
      },
    },
  },
})
