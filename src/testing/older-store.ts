import type { CacheDatabase } from "../store/driver.js"

// What a migration created that replaying it would create again; a migration that only updates rows needs nothing.
const UNDO: Record<number, string> = {
  7: `DROP TRIGGER mention_pending_message_ai; DROP TRIGGER mention_pending_message_au;
    DROP TRIGGER mentions_message_ad; DROP TABLE mentions; DROP TABLE mention_pending;`,
}

/** Makes a store look as if it stopped before `version`, so the next open replays every migration from there. */
export const rollBackTo = (database: CacheDatabase, version: number): void => {
  for (const [from, sql] of Object.entries(UNDO)) if (Number(from) >= version) database.exec(sql)
  database.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(version)
}
