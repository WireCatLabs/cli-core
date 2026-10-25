import type { CacheDatabase } from "./driver.js"
import { MIGRATIONS, type Migration } from "./migrations.js"

export const SPEAKS = MIGRATIONS.at(-1)?.version ?? 0

export interface FileSchema {
  version: number
  minCompatible: number
}

/** Where the file stands against this build: `missing` and `older` are what this build's next run migrates. */
export type SchemaReason = "missing" | "older" | "current" | "newer" | "too_new"

/** An empty file is normal: `openStore` creates it before the first migration runs. */
export const fileSchemaOf = (database: CacheDatabase): FileSchema => {
  const tracked = database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations'").get()
  const row = tracked
    ? database.prepare("SELECT version, min_compatible FROM schema_migrations ORDER BY version DESC LIMIT 1").get()
    : undefined
  return { version: Number(row?.version ?? 0), minCompatible: Number(row?.min_compatible ?? 0) }
}

/** The negation of `migrate`'s refusal: a newer file stays open to this build until its minimum passes it. */
export const writableBy = ({ version, minCompatible }: FileSchema, speaks = SPEAKS): boolean =>
  version <= speaks || minCompatible <= speaks

/**
 * What this build makes of the file, and what its next run would leave behind: `upgrade.minCompatible` is the
 * minimum the file will demand afterwards, so a caller can name every other tool that will then refuse it.
 */
export const compatibilityOf = (file: FileSchema | undefined, migrations: readonly Migration[] = MIGRATIONS) => {
  const speaks = migrations.at(-1)?.version ?? 0
  const { version, minCompatible } = file ?? { version: 0, minCompatible: 0 }
  const writable = writableBy({ version, minCompatible }, speaks)
  const reason: SchemaReason = !file
    ? "missing"
    : version < speaks
      ? "older"
      : version === speaks
        ? "current"
        : writable
          ? "newer"
          : "too_new"
  const raisedTo = migrations
    .filter((migration) => migration.version > version)
    .reduce((highest, migration) => Math.max(highest, migration.minCompatible), minCompatible)
  return {
    version,
    minCompatible,
    speaks,
    writable,
    reason,
    upgrade: version < speaks ? { version: speaks, minCompatible: raisedTo } : null,
  }
}
