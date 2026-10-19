import type { Id, Message, Provider } from "../domain/models.js"
import * as accounts from "./sqlite/accounts.js"
import * as chatQueries from "./sqlite/chats.js"
import * as identities from "./sqlite/identities.js"
import * as messageWrites from "./sqlite/messages.js"
import type { StoreContext } from "./sqlite/open.js"
import * as sync from "./sqlite/sync.js"
import type { AccountKey, PersonFacts } from "./types.js"

/** The row ids behind an account and a chat, and the writes several areas share. */
export const keysOver = (context: StoreContext) => {
  const findAccountPk = (key: AccountKey) => accounts.findAccountPk(context, key)
  const findChatPk = (accountKey: number, chatId: Id) => chatQueries.findChatPk(context, accountKey, chatId)
  return {
    accountPk: (key: AccountKey, name: string | null = null) => accounts.accountPk(context, key, name),
    findAccountPk,
    findChatPk,
    chatKeyOf: (key: AccountKey, chatId: Id) => {
      const accountKey = findAccountPk(key)
      return accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
    },
    chatPkFor: (accountKey: number, chatId: Id) => chatQueries.chatPkFor(context, accountKey, chatId),
    answeredChatPk: (accountKey: number, chatId: Id, typed: Id) =>
      chatQueries.answeredChatPk(context, accountKey, chatId, typed),
    identityPk: (
      accountKey: number,
      provider: Provider,
      nativeId: Id,
      name: string | null,
      facts?: Omit<PersonFacts, "id" | "name">,
    ) => identities.identityPk(context, accountKey, provider, nativeId, name, facts),
    upsertMessage: (
      key: AccountKey,
      accountKey: number,
      chatKey: number,
      message: Message,
      via: string,
      seenAt?: number,
    ) => messageWrites.upsertMessage(context, key, accountKey, chatKey, message, via, seenAt),
    writeMembers: (key: AccountKey, accountKey: number, chatId: Id, memberIds: Id[]) =>
      chatQueries.writeMembers(context, key, accountKey, chatId, memberIds),
    writeState: (accountKey: number, name: string, value: string) => sync.writeState(context, accountKey, name, value),
  }
}
