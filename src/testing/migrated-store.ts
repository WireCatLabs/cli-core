import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TestProject } from "vitest/node"

declare module "vitest" {
  export interface ProvidedContext {
    migratedStore: string
  }
}

/**
 * vitest's `globalSetup`: migrates one empty store for the whole run, which fresh-store.ts copies for each new store.
 * Built from the checkout's migrations at the start of every run, so it cannot be stale; each run has its own folder.
 */
export default async function setup(project: TestProject): Promise<() => void> {
  const dir = mkdtempSync(join(tmpdir(), "wirecat-migrated-"))
  const path = join(dir, "migrated.db")
  const { openSqlite } = await import("../store/sqlite/open.js")
  const { migrate } = await import("../store/migrations.js")
  const { database } = await openSqlite(path)
  try {
    migrate(database)
  } finally {
    database.close()
  }
  project.provide("migratedStore", path)
  // In watch mode this module is not loaded again, so an edited migration would not reach the file; without it each
  // test file migrates its own, as it would with no global setup.
  project.onTestsRerun(() => rmSync(path, { force: true }))
  return () => rmSync(dir, { recursive: true, force: true })
}
