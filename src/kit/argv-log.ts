import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"

/** Where each test run records which commands and options it drove (`pnpm test:matrix`). */
export const ARGV_LOG = join(process.cwd(), "coverage", "argv.jsonl")

/** A vitest `globalSetup`: one run, one log. */
export const argvLogSetup = (): void => {
  mkdirSync(join(process.cwd(), "coverage"), { recursive: true })
  rmSync(ARGV_LOG, { force: true })
}
