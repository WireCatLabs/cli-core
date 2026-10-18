import { CliError } from "@wirecat/cli-base"
import { createTagRedirectIndex, type TagRedirectSnapshot } from "../../domain/tag-redirects.js"
import type { CacheDatabase } from "../driver.js"

export const tagCanonicalId = (database: CacheDatabase, id: number): number => {
  const row = database.prepare("SELECT canonical_id FROM resolved_tags WHERE id=?").get(id)
  if (!row) throw new CliError("not_found", "the selected tag is unavailable")
  return Number(row.canonical_id)
}

export const tagMemberIds = (database: CacheDatabase, id: number): number[] => {
  const canonical = tagCanonicalId(database, id)
  return database
    .prepare("SELECT ? AS id UNION ALL SELECT source_id AS id FROM tag_redirects WHERE survivor_id=? ORDER BY id")
    .all(canonical, canonical)
    .map((row) => Number(row.id))
}

export const tagRedirectSnapshot = (database: CacheDatabase): TagRedirectSnapshot => {
  const tags = database.prepare("SELECT id FROM canonical_tags WHERE kind='tag' ORDER BY id LIMIT 4097").all()
  const redirects = database
    .prepare("SELECT source_id,survivor_id FROM tag_redirects ORDER BY source_id LIMIT 4097")
    .all()
  if (tags.length > 4096 || redirects.length > 4096)
    throw new CliError("validation_error", "tag consolidation exceeds the complete graph budget of 4096 rows")
  const snapshot: TagRedirectSnapshot = {
    complete: true,
    tags: tags.map((row) => ({ id: String(row.id), kind: "tag" })),
    redirects: redirects.map((row) => ({ sourceId: String(row.source_id), survivorId: String(row.survivor_id) })),
  }
  createTagRedirectIndex(snapshot)
  const sources = new Set(snapshot.redirects.map((row) => row.sourceId))
  if (snapshot.redirects.some((row) => sources.has(row.survivorId)))
    throw new CliError("configuration_error", "tag redirects must point directly to a canonical tag")
  return snapshot
}
