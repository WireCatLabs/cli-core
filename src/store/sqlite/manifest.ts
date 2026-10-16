import type { Migration } from "../migrations.js"
import { GENERATED } from "./migrations.generated.js"

/**
 * Every folder drizzle-kit generated, in order, and the schema version it becomes. Consecutive
 * folders may share a version — a generated one and a `--custom` one for its triggers — and are
 * applied as one migration, one `schema_migrations` row. The initial folder holds both: the SQL drizzle-kit
 * generated and, after it, the FTS5 tables, triggers and seed rows it cannot. The version and
 * `minCompatible` are ours, not Drizzle's: `schema_migrations` is the only log, and every build
 * already installed decides by it.
 */
export interface ManifestEntry {
  name: string
  version: number
  minCompatible: number
}

/** One migration creates the whole schema; every later one is added as the next version. */
export const MANIFEST: ManifestEntry[] = [
  { name: "20261010184427_initial", version: 1, minCompatible: 1 },
  { name: "20261011035353_version-2-facts", version: 2, minCompatible: 1 },
  { name: "20261011035430_version-2-facts-from-memories", version: 2, minCompatible: 1 },
  { name: "20261011115708_version-3-vocabulary", version: 3, minCompatible: 1 },
  { name: "20261011172120_version-4-task-next-check", version: 4, minCompatible: 1 },
  { name: "20261013090001_version-5-file-name-words", version: 5, minCompatible: 1 },
  { name: "20261013201057_version-6-query-tree-keys", version: 6, minCompatible: 1 },
  { name: "20261013215247_version-7-mentions", version: 7, minCompatible: 1 },
  { name: "20261013215251_version-7-mentions-triggers", version: 7, minCompatible: 1 },
  { name: "20261014100438_version-8-folded-names", version: 8, minCompatible: 1 },
  { name: "20261014105203_version-9-folded-fill", version: 9, minCompatible: 1 },
  { name: "20261014123446_version-10-mentions-in-attachments", version: 10, minCompatible: 1 },
  { name: "20261014125554_version-11-organization-identities", version: 11, minCompatible: 1 },
  { name: "20261014195259_version-12-mail-rules", version: 12, minCompatible: 1 },
  { name: "20261014204055_version-13-task-fields", version: 13, minCompatible: 1 },
  { name: "20261014222837_version-14-task-words", version: 14, minCompatible: 1 },
  { name: "20261014222841_version-14-task-words-triggers", version: 14, minCompatible: 1 },
  { name: "20261015010543_version-15-task-pairs", version: 15, minCompatible: 1 },
  { name: "20261015014428_version-16-mentions-in-other-texts", version: 16, minCompatible: 1 },
  { name: "20261016091439_version-17-agent-close", version: 17, minCompatible: 1 },
  { name: "20261016205235_version-18-places", version: 18, minCompatible: 1 },
]

export const generatedMigrations = (
  manifest: ManifestEntry[] = MANIFEST,
  generated: { name: string; statements: string[] }[] = GENERATED,
): Migration[] => {
  const migrations: Migration[] = []
  for (const entry of manifest) {
    const found = generated.find(({ name }) => name === entry.name)
    if (!found) throw new Error(`migration ${entry.name} is in the manifest and not in the bundle — run pnpm db:bundle`)
    const last = migrations.at(-1)
    if (last?.version !== entry.version) {
      migrations.push({ version: entry.version, minCompatible: entry.minCompatible, statements: [...found.statements] })
    } else if (last.minCompatible !== entry.minCompatible) {
      throw new Error(`the rows of version ${entry.version} disagree on minCompatible`)
    } else {
      last.statements.push(...found.statements)
    }
  }
  return migrations
}
