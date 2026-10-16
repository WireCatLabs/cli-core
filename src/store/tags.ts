import type { StoreContext } from "./sqlite/open.js"
import type { AnyTagTarget, StoredTag, TagFilter } from "./sqlite/tags.js"
import * as tagQueries from "./sqlite/tags.js"
import { write } from "./sqlite/transaction.js"
import type { AccountKey } from "./types.js"

export interface TagsStore {
  /** Labels one stored chat, person or message; answers the tags it did not have. `not_found` for one not held. */
  addTags(key: AccountKey, target: AnyTagTarget, tags: string[]): Promise<string[]>
  /** Answers the tags it had. */
  removeTags(key: AccountKey, target: AnyTagTarget, tags: string[], source?: "manual" | "auto"): Promise<string[]>
  /** The account's tagged chats and messages, and its messenger's tagged people. */
  tags(key: AccountKey, filter?: TagFilter): Promise<StoredTag[]>
}

export const tagsStoreOver = (context: StoreContext): TagsStore => {
  const { database } = context
  return {
    addTags: async (key, target, list) => {
      let added: string[] = []
      write(database, () => {
        added = tagQueries.addTags(context, tagQueries.targetThing(context, key, target), list)
      })
      return added
    },

    removeTags: async (key, target, list, source) => {
      let removed: string[] = []
      write(database, () => {
        removed = tagQueries.removeTags(context, tagQueries.targetThing(context, key, target), list, source)
      })
      return removed
    },

    tags: async (key, filter = {}) => tagQueries.tagsOf(context, key, filter),
  }
}
