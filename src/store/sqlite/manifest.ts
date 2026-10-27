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
  { name: "20261017000856_version-19-mail-sender-score", version: 19, minCompatible: 1 },
  { name: "20261017095620_version-20-poll-votes", version: 20, minCompatible: 1 },
  { name: "20261017141028_version-21-document-annotation-transfers", version: 21, minCompatible: 1 },
  { name: "20261017212239_version-22-mail-demoted", version: 22, minCompatible: 1 },
  { name: "20261018024850_version-23-chat-events", version: 23, minCompatible: 1 },
  { name: "20261018061512_version-24-message-stars", version: 24, minCompatible: 1 },
  { name: "20261018063952_version-24-message-stars-index", version: 24, minCompatible: 1 },
  { name: "20261019115025_version-25-chat-revisions", version: 25, minCompatible: 1 },
  { name: "20261019115027_version-25-chat-revisions-triggers", version: 25, minCompatible: 1 },
  { name: "20261021214318_version-26-message-reactions", version: 26, minCompatible: 1 },
  { name: "20261021221808_version-27-message-delivery", version: 27, minCompatible: 1 },
  { name: "20261021224625_version-28-chat-state", version: 28, minCompatible: 1 },
  { name: "20261023105057_version-29-transcript-words", version: 29, minCompatible: 1 },
  { name: "20261023105101_version-29-transcript-words-triggers", version: 29, minCompatible: 1 },
  { name: "20261025064253_version-30-reviewed-tag-consolidation", version: 30, minCompatible: 30 },
  { name: "20261025064302_version-30-resolved-tag-view", version: 30, minCompatible: 30 },
  { name: "20261025070402_version-31-drive-account", version: 31, minCompatible: 31 },
  { name: "20261025071848_version-32-files", version: 32, minCompatible: 32 },
  { name: "20261025071850_version-32-files-data", version: 32, minCompatible: 32 },
  { name: "20261025072643_version-33-calendars", version: 33, minCompatible: 32 },
  { name: "20261025072644_version-33-calendars-triggers", version: 33, minCompatible: 32 },
  { name: "20261025182500_version-34-vector-index", version: 34, minCompatible: 34 },
  { name: "20261025182501_version-34-vector-index-triggers", version: 34, minCompatible: 34 },
  { name: "20261027102259_version-35-calendar-neutral", version: 35, minCompatible: 34 },
  { name: "20261027102302_version-35-calendar-neutral-data", version: 35, minCompatible: 34 },
]

export const generatedMigrations = (
  manifest: ManifestEntry[] = MANIFEST,
  generated: { name: string; statements: string[] }[] = GENERATED,
): Migration[] => {
  const migrations: Migration[] = []
  for (const entry of manifest) {
    if (!Number.isSafeInteger(entry.minCompatible) || entry.minCompatible < 1 || entry.minCompatible > entry.version)
      throw new Error("each migration requires an explicit valid minCompatible")
    const found = generated.find(({ name }) => name === entry.name)
    if (!found) throw new Error(`migration ${entry.name} is in the manifest and not in the bundle — run pnpm db:bundle`)
    const last = migrations.at(-1)
    if (last && last.version !== entry.version && entry.minCompatible < last.minCompatible)
      throw new Error("migration minCompatible cannot decrease")
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
