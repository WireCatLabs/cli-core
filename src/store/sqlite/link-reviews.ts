import type { CacheDatabase } from "../driver.js"

/**
 * Two or more equally good entities for one source record: one row on the owner's review list (requirements 3.6). A
 * later sync updates the candidates of an open row and leaves a decided one as the owner left it.
 */
export const reviewLink = (
  database: CacheDatabase,
  linkable: { type: string; id: number },
  entity: string,
  candidates: number[],
  reason: string,
  now: number,
): void => {
  database
    .prepare(
      `INSERT INTO link_reviews (linkable_type, linkable_id, entity_type, candidates, reason, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
       ON CONFLICT (linkable_type, linkable_id, entity_type) DO UPDATE SET candidates = excluded.candidates,
         reason = excluded.reason, updated_at = excluded.updated_at WHERE link_reviews.status = 'open'`,
    )
    .run(linkable.type, linkable.id, entity, JSON.stringify([...candidates].sort((a, b) => a - b)), reason, now, now)
}
