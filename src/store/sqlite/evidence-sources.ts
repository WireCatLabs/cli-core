import type { CacheDatabase } from "../driver.js"
import { linkKind } from "./link-kinds.js"
import { type RefRead, refReadsOf } from "./ref-summaries.js"
import { referenceOfThing, storedThing } from "./things.js"

/** One reference a memory or fact rests on, read back whole enough to judge it without opening it. */
export interface EvidenceSource {
  /** `null` when the row is gone from the store and its reference with it. */
  ref: string | null
  kind: string
  title: string | null
  sender: string | null
  at: string | null
  excerpt: string | null
  /** The provider the source came through: `telegram`, `email`, `notes`, `zoom`… */
  tool: string | null
  /** Deleted at its source since it was cited, or no longer in the store. */
  missing: boolean
}

/** A message is known by its chat here, not by the sender and time its summary title says. */
const sourceOf = (read: RefRead, ref: string): EvidenceSource => ({
  ref,
  kind: read.kind,
  title: read.kind === "message" ? read.in : read.title,
  sender: read.sender,
  at: read.at,
  excerpt: read.excerpt,
  tool: read.provider,
  missing: read.state !== "available",
})

/** Each distinct reference read back, in order; one the store no longer resolves keeps its reference, `missing`. */
export const sourcesOfReferences = (database: CacheDatabase, references: readonly string[]): EvidenceSource[] =>
  [...refReadsOf(database, references, { excerpt: true })].map(([ref, read]) => sourceOf(read, ref))

const GONE_KIND: Record<string, string> = { meeting_transcript: "meeting", meeting_transcript_row: "meeting" }

/**
 * Every `evidence` link from a memory or fact, in the order they were written, including one whose target was
 * deleted since: `evidenceOf` drops those, so a reader would never learn the record lost a source.
 */
export const evidenceSourcesOf = (database: CacheDatabase, from: { type: string; id: number }): EvidenceSource[] => {
  const cited = database
    .prepare(
      `SELECT to_type, to_id FROM links WHERE from_type = ? AND from_id = ? AND kind = ${linkKind("evidence")} ` +
        "AND to_id IS NOT NULL ORDER BY id",
    )
    .all(from.type, from.id)
    .map((link) => {
      const thing = storedThing(link.to_type, link.to_id)
      return { type: thing.type, ref: referenceOfThing(database, thing) }
    })
  const reads = refReadsOf(
    database,
    cited.flatMap(({ ref }) => ref ?? []),
    { excerpt: true },
  )
  return cited.map(({ type, ref }) => {
    const read = ref === undefined ? undefined : reads.get(ref)
    if (ref !== undefined && read !== undefined) return sourceOf(read, ref)
    return {
      ref: null,
      kind: GONE_KIND[type] ?? type,
      title: null,
      sender: null,
      at: null,
      excerpt: null,
      tool: null,
      missing: true,
    }
  })
}
