import type { AccountKey, MessageStore } from "../store/index.js"

const PAGE = 500
const MAX_DELETED_SHARE = 0.2
const MIN_DELETIONS_CAPPED = 5

export interface Gone {
  deleted: number
  /** Why stored entries missing at the source were left alone, when they were. */
  skipped?: string
}

/** Why `gone` of `candidates` is too large a share to delete, or `undefined` when it may be deleted. */
export const tooManyGone = (gone: number, candidates: number): string | undefined =>
  gone >= MIN_DELETIONS_CAPPED && gone > candidates * MAX_DELETED_SHARE
    ? `${gone} of ${candidates} stored entries are missing at the source — too many to trust; nothing deleted`
    : undefined

/**
 * What the store holds of this account, from `since` on, and the source no longer lists, was deleted
 * there: its text goes. Wrongly dropping text cannot be undone and a missed deletion is caught on the
 * next run, so an unusually large share missing is refused rather than applied — an unmounted folder or
 * a half-answered listing looks exactly like that.
 */
export const dropMissing = async (
  store: MessageStore,
  key: AccountKey,
  present: { has(id: string): boolean },
  since?: string,
  eligible?: (entry: { chatId: string; id: string }) => Promise<boolean>,
): Promise<Gone> => {
  const stored: { chatId: string; id: string }[] = []
  for (let offset = 0; ; offset += PAGE) {
    const chats = await store.chats.chats(key, { limit: PAGE, offset })
    for (const chat of chats.items) {
      if (since !== undefined && chat.lastMessageAt !== null && chat.lastMessageAt < since) continue
      for (let before: string | undefined; ; ) {
        const page = await store.messages.messages(key, chat.id, {
          limit: PAGE,
          ...(since === undefined ? {} : { since }),
          ...(before === undefined ? {} : { before }),
        })
        stored.push(...page.items.map(({ id }) => ({ chatId: chat.id, id })))
        before = page.items[0]?.id
        if (!page.hasMore || before === undefined) break
      }
    }
    if (!chats.hasMore) break
  }
  const candidates = []
  for (const entry of stored) if (eligible === undefined || (await eligible(entry))) candidates.push(entry)
  const gone = candidates.filter(({ id }) => !present.has(id))
  if (gone.length === 0) return { deleted: 0 }
  const refused = tooManyGone(gone.length, candidates.length)
  if (refused) return { deleted: 0, skipped: refused }
  const byChat = new Map<string, string[]>()
  for (const { chatId, id } of gone) byChat.set(chatId, [...(byChat.get(chatId) ?? []), id])
  let deleted = 0
  for (const [chatId, ids] of byChat) deleted += await store.messages.markDeleted(key, ids, { chatId })
  return { deleted }
}
