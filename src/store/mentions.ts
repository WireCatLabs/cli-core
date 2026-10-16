import { CliError } from "@wirecat/cli-base"
import type { QueryAst } from "@wirecat/cli-base/query"
import type { Decider, MentionKind } from "../domain/mentions.js"
import { keysOver } from "./keys.js"
import {
  confirmMention,
  listMentions,
  type MentionDecision,
  type MentionsRebuild,
  type MentionsState,
  mentionOfAccount,
  mentionOwner,
  mentionsState,
  rebuildMentions,
  rejectMention,
  type StoredMention,
  showMention,
} from "./sqlite/mentions.js"
import type { StoreContext } from "./sqlite/open.js"
import { write } from "./sqlite/transaction.js"
import type { AccountKey } from "./types.js"

export interface AccountMentions {
  /** The account's phones, e-mail addresses, links and documents that match the query, newest message first. */
  mentions(
    key: AccountKey,
    query: QueryAst | undefined,
    window: { limit?: number; offset: number; foundAfter?: number },
  ): Promise<{ items: StoredMention[]; hasMore: boolean }>
  /** One mention of the account, with the text around it; `undefined` for another account's or a missing id. */
  mention(
    key: AccountKey,
    id: number,
  ): Promise<(StoredMention & { before: string; after: string; sameValue: number; candidates: string[] }) | undefined>
  /**
   * Says what a mention's value is, everywhere it is written: a phone or an address belongs to its owner
   * (`person:<uid>` or `organization:<id>`), a document id names the stored document.
   */
  confirmMention(key: AccountKey, id: number, owner: string | undefined, by: Decider): Promise<MentionDecision>
  /** Dismisses a mention's value everywhere it is written, and on later syncs. */
  rejectMention(key: AccountKey, id: number, by: Decider): Promise<MentionDecision>
}

export interface MentionsStore extends AccountMentions {
  /** Finds the mentions of every stored message again, every account's; decisions stay. */
  rebuildMentions(options?: {
    kinds?: readonly MentionKind[]
    onBatch?: (done: number, total: number) => void
  }): Promise<MentionsRebuild>
  mentionsState(): Promise<MentionsState>
}

export const accountMentionsOver = (context: StoreContext): AccountMentions => {
  const { database } = context
  const { findAccountPk } = keysOver(context)
  return {
    mentions: async (key, query, window) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined
        ? { items: [], hasMore: false }
        : listMentions(database, accountKey, query, window)
    },

    mention: async (key, id) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? undefined : showMention(database, accountKey, id)
    },

    confirmMention: async (key, id, ownerRef, by) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) throw new CliError("not_found", `no mention ${id} in this account`)
      const mention = mentionOfAccount(database, accountKey, id)
      return write(database, () => confirmMention(context, mention, mentionOwner(context, ownerRef), by))
    },

    rejectMention: async (key, id, by) => {
      const accountKey = findAccountPk(key)
      if (accountKey === undefined) throw new CliError("not_found", `no mention ${id} in this account`)
      return write(database, () => rejectMention(context, mentionOfAccount(database, accountKey, id), by))
    },
  }
}

export const mentionsStoreOver = (context: StoreContext, keyed: AccountMentions): MentionsStore => ({
  ...keyed,
  rebuildMentions: async (options = {}) => rebuildMentions(context.database, { now: context.now(), ...options }),
  mentionsState: async () => mentionsState(context.database),
})
