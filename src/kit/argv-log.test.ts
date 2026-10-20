import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

it("logs under the working directory and clears the previous run's log", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "argv-log-"))
  vi.spyOn(process, "cwd").mockReturnValue(cwd)
  const { ARGV_LOG, argvLogSetup } = await import("./argv-log.js")
  expect(ARGV_LOG).toBe(join(cwd, "coverage", "argv.jsonl"))

  mkdirSync(join(cwd, "coverage"))
  writeFileSync(ARGV_LOG, "stale\n")
  argvLogSetup()
  expect(existsSync(ARGV_LOG)).toBe(false)
  expect(existsSync(join(cwd, "coverage"))).toBe(true)
})
