import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { vi } from "vitest"

// Migrating an empty store runs about 400 statements, 40–55 ms; a run opened about 1,900 new stores, a fifth of
// the suite's CPU (2026-10-18). A new store starts from a copy of one migrated once per test file instead.
// The rest of opening — the fills, the stemmers, the log pruner — still runs on the copy, with the test's clock.
vi.mock(import("../store/sqlite/open-store.js"), async (importOriginal) => {
  const original = await importOriginal()
  let template: Buffer | undefined
  const migrated = async (): Promise<Buffer> => {
    if (template) return template
    const { openSqlite } = await import("../store/sqlite/open.js")
    const { migrate } = await import("../store/migrations.js")
    const path = join(tmpdir(), "migrated-template.db")
    const { database } = await openSqlite(path)
    migrate(database)
    database.close()
    template = readFileSync(path)
    return template
  }
  return {
    ...original,
    openStoreContext: async (options = {}) => {
      if (!options.readOnly) {
        const { storePath } = await import("../store/path.js")
        const file = options.path ?? storePath(options.env)
        if (!statSync(file, { throwIfNoEntry: false })?.size && !existsSync(`${file}-wal`)) {
          try {
            mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
            writeFileSync(file, await migrated(), { mode: 0o600 })
          } catch {
            // Left to the real open, which says what is wrong with the path the way a user sees it.
          }
        }
      }
      return original.openStoreContext(options)
    },
  }
})
