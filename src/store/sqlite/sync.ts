import { and, eq, lte, or, sql } from "./drizzle/core.js"
import type { StoreContext } from "./open.js"
import { fetchLeases, syncCursors } from "./schema.js"
import { toIso } from "./values.js"

export const syncStateOf = ({ orm }: StoreContext, accountKey: number, name: string) => {
  const row = orm
    .select({ value: syncCursors.value, at: syncCursors.updatedAt })
    .from(syncCursors)
    .where(and(eq(syncCursors.accountId, accountKey), eq(syncCursors.key, name)))
    .get()
  return row ? { value: row.value, at: toIso(row.at) as string } : undefined
}

/** A sync state value saved with `MailStore.saveThreads`, by the account's row id. */
export interface SyncStateSave {
  accountId: number
  name: string
  value: string
}

export const writeState = (
  { orm, now }: Pick<StoreContext, "orm" | "now">,
  accountKey: number,
  name: string,
  value: string,
): void => {
  orm
    .insert(syncCursors)
    .values({ accountId: accountKey, key: name, value, createdAt: now(), updatedAt: now() })
    .onConflictDoUpdate({
      target: [syncCursors.accountId, syncCursors.key],
      set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
    })
    .run()
}

export const clearState = ({ orm }: StoreContext, accountKey: number, name: string): void => {
  orm
    .delete(syncCursors)
    .where(and(eq(syncCursors.accountId, accountKey), eq(syncCursors.key, name)))
    .run()
}

/** Taken when free, expired, or already this holder's; another holder's running lease stays. */
export const claim = (
  { orm, now }: StoreContext,
  chatKey: number,
  anchor: string,
  holder: string,
  forMs: number,
): boolean => {
  const at = now()
  return (
    orm
      .insert(fetchLeases)
      .values({ chatId: chatKey, anchor, holder, expiresAt: at + forMs })
      .onConflictDoUpdate({
        target: [fetchLeases.chatId, fetchLeases.anchor],
        set: { holder: sql`excluded.holder`, expiresAt: sql`excluded.expires_at` },
        setWhere: or(eq(fetchLeases.holder, sql`excluded.holder`), lte(fetchLeases.expiresAt, at)),
      })
      .returning({ chatId: fetchLeases.chatId })
      .all().length > 0
  )
}

export const release = ({ orm }: StoreContext, chatKey: number, anchor: string, holder: string): void => {
  orm
    .delete(fetchLeases)
    .where(and(eq(fetchLeases.chatId, chatKey), eq(fetchLeases.anchor, anchor), eq(fetchLeases.holder, holder)))
    .run()
}
