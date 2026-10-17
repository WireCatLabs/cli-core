import { existsSync } from "node:fs"
import { join } from "node:path"
import { CliError } from "@wirecat/cli-base"
import { createMeetingPreparationService } from "../src/services/meeting-preparation.js"
import { openSqlite } from "../src/store/sqlite/open.js"
import { openStore } from "../src/store/store.js"
import { contextEvidenceFixture } from "../src/testing/context-evidence.js"

export const smokeReadOnlyStore = async (check: (name: string, passes: boolean) => void) => {
  const f = await contextEvidenceFixture()
  try {
    const snapshot = () =>
      JSON.stringify({
        messages: f.db.prepare("SELECT * FROM messages ORDER BY id").all(),
        documents: f.db.prepare("SELECT * FROM documents ORDER BY id").all(),
        mail: f.db.prepare("SELECT * FROM emails ORDER BY id").all(),
        settings: f.db.prepare("SELECT * FROM store_settings ORDER BY key").all(),
      })
    const before = snapshot()
    const store = await openStore({ path: f.path, readOnly: true, now: () => 100 * 86400000 })
    try {
      if (!store.contextEvidence) throw new Error("Missing read-only context capability")
      const selections = Object.entries(f.sources).map(([id, source]) => ({ id, source }))
      const service = createMeetingPreparationService(f.key, f.accountId, {
        meetings: store.meetings,
        upcoming: f.upcoming,
        communications: { selections, reader: store.contextEvidence },
      })
      const result = await service.prepare("example-series", {
        after: 10000,
        until: 20000,
        historyAfter: 0,
        communications: { query: "launch", sources: selections.map(({ id }) => ({ id })) },
      })
      check("read-only store supports complete preparation", result.communications?.items.length === 5)
      check("read-only preparation leaves source rows unchanged", snapshot() === before)
    } finally {
      await store.close()
    }
    const opened = await openSqlite(f.path, { readOnly: true })
    try {
      opened.database.exec("PRAGMA query_only=OFF")
      let denied = false
      try {
        opened.database.exec("CREATE TABLE forbidden_read_only(id INTEGER)")
      } catch {
        denied = true
      }
      check("native read-only handle refuses writes with query_only disabled", denied)
    } finally {
      opened.database.close()
    }
    const missing = join(f.path, "..", "missing", "store.db")
    const refused = await openStore({ path: missing, readOnly: true }).then(
      async (unexpected) => {
        await unexpected.close()
        return false
      },
      (error) => error instanceof CliError && error.code === "not_found",
    )
    check("read-only missing store is refused without creation", refused && !existsSync(missing))
  } finally {
    await f.close()
  }
}
