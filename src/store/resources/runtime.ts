import type { Id, Message, Provider } from "../../domain/models.js"
import type { QueryExecution } from "../../search/lucene/resolved.js"
import type { AccountKey, PersonFacts } from "../contracts/models.js"
import * as accounts from "../sqlite/accounts.js"
import * as chatQueries from "../sqlite/chats.js"
import type { MailStore } from "../sqlite/emails.js"
import { drainEmailIndex, mailStoreOver } from "../sqlite/emails.js"
import * as identities from "../sqlite/identities.js"
import { drainInvolvementQueue } from "../sqlite/involvement-queue.js"
import { logPruner } from "../sqlite/log-pruning.js"
import * as messageWrites from "../sqlite/messages.js"
import type { StoreContext } from "../sqlite/open.js"
import * as stems from "../sqlite/stems.js"
import * as sync from "../sqlite/sync.js"

export const storeRuntime = (context: StoreContext) => {
  const { database } = context

  const stemmerFor = stems.stemmerCache()

  const pruneLogsWhenDue = logPruner(database, context.now)

  const inTransaction = (body: () => void): void => {
    database.exec("BEGIN IMMEDIATE")
    try {
      body()
      stems.drainStems(database, stemmerFor)
      drainInvolvementQueue(database)
      database.exec("COMMIT")
    } catch (error) {
      database.exec("ROLLBACK")
      throw error
    }
  }

  const mailIndexed = (execution: QueryExecution) => {
    if (execution.corpus === "mail") drainEmailIndex(database, stemmerFor)
    return execution
  }

  const accountPk = (key: AccountKey, name: string | null = null) => accounts.accountPk(context, key, name)

  const findAccountPk = (key: AccountKey) => accounts.findAccountPk(context, key)

  const findChatPk = (accountKey: number, chatId: Id) => chatQueries.findChatPk(context, accountKey, chatId)

  const chatKeyOf = (key: AccountKey, chatId: Id) => {
    const accountKey = findAccountPk(key)
    return accountKey === undefined ? undefined : findChatPk(accountKey, chatId)
  }

  const chatPkFor = (accountKey: number, chatId: Id) => chatQueries.chatPkFor(context, accountKey, chatId)

  const identityPk = (
    accountKey: number,
    provider: Provider,
    nativeId: Id,
    name: string | null,
    facts?: Omit<PersonFacts, "id" | "name">,
  ) => identities.identityPk(context, accountKey, provider, nativeId, name, facts)

  const upsertMessage = (
    key: AccountKey,
    accountKey: number,
    chatKey: number,
    message: Message,
    via: string,
    seenAt?: number,
  ) => messageWrites.upsertMessage(context, key, accountKey, chatKey, message, via, seenAt)

  const writeMembers = (key: AccountKey, accountKey: number, chatId: Id, memberIds: Id[]) =>
    chatQueries.writeMembers(context, key, accountKey, chatId, memberIds)

  const writeState = (accountKey: number, name: string, value: string) =>
    sync.writeState(context, accountKey, name, value)

  let mail: MailStore | undefined

  const mailOf = () => {
    mail ??= mailStoreOver(context, stemmerFor)
    return mail
  }
  return {
    context,
    database,
    stemmerFor,
    pruneLogsWhenDue,
    inTransaction,
    mailIndexed,
    accountPk,
    findAccountPk,
    findChatPk,
    chatKeyOf,
    chatPkFor,
    identityPk,
    upsertMessage,
    writeMembers,
    writeState,
    mailOf,
  }
}
export type StoreRuntime = ReturnType<typeof storeRuntime>
