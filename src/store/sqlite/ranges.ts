import type { Range } from "../types.js"
import { and, eq, gte, lte } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"
import { syncRanges } from "./schema.js"

/** Merges `from`–`to` with every stretch it overlaps or touches, and answers the merged stretch. */
export const markRange = ({ orm, now }: StoreContext, chatKey: number, from: number, to: number): Range => {
  const touching = and(eq(syncRanges.chatId, chatKey), lte(syncRanges.fromKey, to + 1), gte(syncRanges.toKey, from - 1))
  let merged: Range = { from, to }
  for (const row of orm.select().from(syncRanges).where(touching).all()) {
    merged = { from: Math.min(merged.from, row.fromKey), to: Math.max(merged.to, row.toKey) }
  }
  orm.delete(syncRanges).where(touching).run()
  orm
    .insert(syncRanges)
    .values({ chatId: chatKey, fromKey: merged.from, toKey: merged.to, createdAt: now(), updatedAt: now() })
    .run()
  return merged
}

export const ranges = ({ orm }: StoreContext, chatKey: number): Range[] =>
  orm
    .select({ from: syncRanges.fromKey, to: syncRanges.toKey })
    .from(syncRanges)
    .where(eq(syncRanges.chatId, chatKey))
    .orderBy(syncRanges.fromKey)
    .all()
