import { type Area, bindAccount, type Keyed } from "./account-store.js"
import { type AccountAccounts, accountAccountsOver, accountsStoreOver } from "./accounts.js"
import { type AccountAttachments, accountAttachmentsOver, attachmentsStoreOver } from "./attachments.js"
import { type ChatsStore, chatsStoreOver } from "./chats.js"
import { type ConversationsStore, conversationsStoreOver } from "./conversations.js"
import { type AccountCounters, accountCountersOver, countersStoreOver } from "./counters.js"
import { DEFAULT_DECISION_POLICY } from "./decisions.js"
import { type AccountMentions, accountMentionsOver, mentionsStoreOver } from "./mentions.js"
import type { MessageStore } from "./message-store.js"
import { type AccountMessages, accountMessagesOver, messagesStoreOver } from "./messages.js"
import { type AccountPeople, accountPeopleOver, peopleStoreOver } from "./people.js"
import { queriesStoreOver } from "./queries.js"
import { type RosterStore, rosterStoreOver } from "./roster.js"
import { searchIndexStoreOver } from "./search-index.js"
import { searchesStoreOver } from "./searches.js"
import * as accounts from "./sqlite/accounts.js"
import { addedSourcesOver } from "./sqlite/added-sources.js"
import { agentActionsStoreOver } from "./sqlite/agent-actions.js"
import * as attachmentTexts from "./sqlite/attachment-texts.js"
import { baseStagesStoreOver } from "./sqlite/base-stages.js"
import { botUpdateStoreOver } from "./sqlite/bot-updates.js"
import { contractsStoreOver } from "./sqlite/business-contracts.js"
import { businessSearchOver } from "./sqlite/business-search.js"
import { eventStoreOver } from "./sqlite/calendar.js"
import { catalogStoreOver } from "./sqlite/catalog.js"
import { contentStoreOver } from "./sqlite/content.js"
import { contextEvidenceOver, contextIndexOver, contextRecordsOver } from "./sqlite/context-evidence.js"
import { crmCopiesOver } from "./sqlite/crm.js"
import { crmFilesOver } from "./sqlite/crm-files.js"
import { dealsStoreOver } from "./sqlite/deals.js"
import { decisionRequestStoreOver } from "./sqlite/decision-requests.js"
import { documentListingOver } from "./sqlite/document-listing.js"
import { mailStoreOver } from "./sqlite/emails.js"
import { enrichmentsOver } from "./sqlite/enrichments.js"
import { eventSearchOver } from "./sqlite/event-search.js"
import { evidenceFindingsStoreOver } from "./sqlite/evidence-findings.js"
import { factsStoreOver } from "./sqlite/facts.js"
import { filesStoreOver } from "./sqlite/files.js"
import { financeStoreOver } from "./sqlite/finance.js"
import { involvementStoreOver } from "./sqlite/involvements.js"
import { knowledgeStoreOver } from "./sqlite/knowledge.js"

export { SCOPES } from "./sqlite/knowledge.js"

import { logPruner } from "./sqlite/log-pruning.js"
import { mailFindingsStoreOver } from "./sqlite/mail-findings.js"
import { meetingFindingsStoreOver } from "./sqlite/meeting-findings.js"
import { meetingListingOver } from "./sqlite/meeting-listing.js"
import { meetingVectorsOver } from "./sqlite/meeting-vectors.js"
import { meetingStoreOver } from "./sqlite/meetings.js"
import { memoriesStoreOver } from "./sqlite/memories.js"
import { sourceMentionStoreOver } from "./sqlite/mention-sources.js"
import { transactionsStoreOver } from "./sqlite/money-transactions.js"
import { noteSearchOver } from "./sqlite/note-search.js"
import { notesStoreOver } from "./sqlite/notes.js"
import type { StoreContext } from "./sqlite/open.js"
import { openStoreContext, type StoreOptions } from "./sqlite/open-store.js"
import { ordersStoreOver } from "./sqlite/orders.js"
import { productsStoreOver } from "./sqlite/products.js"
import { projectAnnotationStoreOver } from "./sqlite/project-transfer/store.js"
import { proposedActionsStoreOver } from "./sqlite/proposed-actions.js"
import { recordStoreOver } from "./sqlite/records.js"
import { refsStoreOver } from "./sqlite/ref-summaries.js"
import { relationsStoreOver } from "./sqlite/reported-relations.js"
import * as stems from "./sqlite/stems.js"
import { subscriptionsStoreOver } from "./sqlite/subscriptions.js"
import { taskStoreOver } from "./sqlite/tasks.js"
import { templateStoreOver } from "./sqlite/templates.js"
import { trackerStoreOver } from "./sqlite/tracker.js"
import { walletsStoreOver } from "./sqlite/wallets.js"
import { storeErrors } from "./store-errors.js"
import { type SyncStore, syncStoreOver } from "./sync.js"
import { type TagsStore, tagsStoreOver } from "./tags.js"
import { type AccountVectors, accountVectorsOver, vectorsStoreOver } from "./vectors.js"

export type { ChatHistoryShape, StoredHistorySkip } from "./sqlite/history-skips.js"
export { BACKFILL_ON_OPEN, type StoreOptions } from "./sqlite/open-store.js"
export type { ChatScope, NewestMessage, ReplyDelay, WaitingChat } from "./sqlite/reply-times.js"
export { rollBack } from "./sqlite/rollback-copy.js"
export { fileFacts, readStoreTables, type TableKind } from "./sqlite/store-tables.js"

export const openStore = async (options: StoreOptions = {}): Promise<MessageStore> => {
  const context = await openStoreContext(options)
  try {
    return storeOver(context)
  } catch (error) {
    context.database.close()
    throw error
  }
}

/** Built on first use, once, so a spy on an area sees every call. */
const once = <T>(build: () => T): (() => T) => {
  let built: T | undefined
  return () => (built ??= storeErrors(build()))
}

const areaOf = <K extends Keyed<K>, A extends K>(keyed: () => K, whole: (keyed: K) => A): (() => Area<K, A>) =>
  once(() => {
    const part = keyed()
    return { keyed: part, whole: whole(part) }
  })

const storeOver = (context: StoreContext): MessageStore => {
  const { database } = context
  const stemmerFor = stems.stemmerCache()
  const pruneLogsWhenDue = logPruner(database, context.now)
  const own = <K extends Keyed<K>>(keyed: K): K => ({ ...keyed })

  // Built on first use: an area that prepares its statements must not stop the store opening for the rest.
  const mail = once(() => mailStoreOver(context, stemmerFor))
  const areas = {
    accounts: areaOf(
      () => accountAccountsOver(context),
      (keyed: AccountAccounts) => accountsStoreOver(context, keyed),
    ),
    chats: areaOf((): ChatsStore => chatsStoreOver(context), own),
    sync: areaOf((): SyncStore => syncStoreOver(context), own),
    messages: areaOf(
      () => accountMessagesOver(context),
      (keyed: AccountMessages) => messagesStoreOver(context, keyed),
    ),
    attachments: areaOf(
      () => accountAttachmentsOver(context),
      (keyed: AccountAttachments) => attachmentsStoreOver(context, keyed),
    ),
    roster: areaOf((): RosterStore => rosterStoreOver(context), own),
    people: areaOf(
      () => accountPeopleOver(context),
      (keyed: AccountPeople) => peopleStoreOver(context, keyed),
    ),
    conversations: areaOf((): ConversationsStore => conversationsStoreOver(context), own),
    vectors: areaOf(
      () => accountVectorsOver(context, mail),
      (keyed: AccountVectors) => vectorsStoreOver(context, keyed),
    ),
    counters: areaOf(
      () => accountCountersOver(context),
      (keyed: AccountCounters) => countersStoreOver(context, keyed),
    ),
    tags: areaOf((): TagsStore => tagsStoreOver(context), own),
    mentions: areaOf(
      () => accountMentionsOver(context),
      (keyed: AccountMentions) => mentionsStoreOver(context, keyed),
    ),
  }
  const contextEvidence = once(() => contextEvidenceOver(context))
  const projectAnnotations = once(() => projectAnnotationStoreOver(context))
  const contextIndex = once(() => contextIndexOver(context, stemmerFor))
  const contextRecords = once(() => contextRecordsOver(context))
  const searches = once(() => searchesStoreOver(context))
  const queries = once(() => queriesStoreOver(context, stemmerFor))
  const searchIndex = once(() => searchIndexStoreOver(context))
  const botUpdates = once(() => botUpdateStoreOver(context, pruneLogsWhenDue))
  const involvements = once(() => involvementStoreOver(context))
  const tasks = once(() => taskStoreOver(context))
  const sourceMentions = once(() => sourceMentionStoreOver(context))
  const knowledge = once(() => knowledgeStoreOver(context))
  const notes = once(() => ({ ...notesStoreOver(context), ...addedSourcesOver(context), ...noteSearchOver(context) }))
  const catalog = once(() => catalogStoreOver(context))
  const files = once(() => filesStoreOver(context))
  const listings = once(() => ({ ...documentListingOver(context), ...meetingListingOver(context) }))
  const calendar = once(() => ({ ...eventStoreOver(context), ...eventSearchOver(context) }))
  const meetingFindings = once(() => meetingFindingsStoreOver(context))
  const evidenceFindings = once(() => evidenceFindingsStoreOver(context))
  const mailFindings = once(() => mailFindingsStoreOver(context))
  const refs = refsStoreOver(context)
  const facts = once(() => factsStoreOver(context))
  const finance = once(() => financeStoreOver(context))
  const orders = once(() => ordersStoreOver(context))
  const deals = once(() => dealsStoreOver(context))
  const baseStages = once(() => baseStagesStoreOver(context))
  const products = once(() => productsStoreOver(context))
  const contracts = once(() => contractsStoreOver(context))
  const subscriptions = once(() => subscriptionsStoreOver(context))
  const wallets = once(() => walletsStoreOver(context))
  const transactions = once(() => transactionsStoreOver(context))
  const crm = once(() => crmCopiesOver(context, accountPeopleOver(context)))
  const crmFiles = once(() => crmFilesOver(context))
  const tracker = once(() => trackerStoreOver(context))
  const content = once(() => contentStoreOver(context))
  const relations = once(() => relationsStoreOver(context))
  const decisionRequests = once(() => decisionRequestStoreOver(context))
  const templates = once(() => templateStoreOver(context))
  const records = once(() => recordStoreOver(context))
  const memories = once(() => memoriesStoreOver(context))
  const proposedActions = once(() => proposedActionsStoreOver(context))
  const agentActions = once(() => agentActionsStoreOver(context, pruneLogsWhenDue))
  const meetings = once(() => meetingStoreOver(context))
  const enrichment = once(() => enrichmentsOver(context))

  const store: MessageStore = {
    get enrichment() {
      return enrichment()
    },
    get projectAnnotations() {
      return projectAnnotations()
    },
    get contextEvidence() {
      return contextEvidence()
    },
    get contextIndex() {
      return contextIndex()
    },
    get contextRecords() {
      return contextRecords()
    },
    meetingVectors: meetingVectorsOver(context),
    get accounts() {
      return areas.accounts().whole
    },
    get chats() {
      return areas.chats().whole
    },
    get sync() {
      return areas.sync().whole
    },
    get messages() {
      return areas.messages().whole
    },
    get attachments() {
      return areas.attachments().whole
    },
    get roster() {
      return areas.roster().whole
    },
    get people() {
      return areas.people().whole
    },
    get conversations() {
      return areas.conversations().whole
    },
    get vectors() {
      return areas.vectors().whole
    },
    get counters() {
      return areas.counters().whole
    },
    get tags() {
      return areas.tags().whole
    },
    get mentions() {
      return areas.mentions().whole
    },
    get searches() {
      return searches()
    },
    get queries() {
      return queries()
    },
    get searchIndex() {
      return searchIndex()
    },
    get botUpdates() {
      return botUpdates()
    },
    get involvements() {
      return involvements()
    },
    get tasks() {
      return tasks()
    },
    get sourceMentions() {
      return sourceMentions()
    },
    get knowledge() {
      return knowledge()
    },
    get notes() {
      return notes()
    },
    get catalog() {
      return catalog()
    },
    get files() {
      return files()
    },
    get listings() {
      return listings()
    },
    get calendar() {
      return calendar()
    },
    get meetingFindings() {
      return meetingFindings()
    },
    refs,
    business: businessSearchOver(context),
    get evidenceFindings() {
      return evidenceFindings()
    },
    get mailFindings() {
      return mailFindings()
    },
    get facts() {
      return facts()
    },
    get finance() {
      return finance()
    },
    get orders() {
      return orders()
    },
    get deals() {
      return deals()
    },
    get baseStages() {
      return baseStages()
    },
    get products() {
      return products()
    },
    get contracts() {
      return contracts()
    },
    get subscriptions() {
      return subscriptions()
    },
    get wallets() {
      return wallets()
    },
    get transactions() {
      return transactions()
    },
    get crm() {
      return crm()
    },
    get tracker() {
      return tracker()
    },
    get content() {
      return content()
    },
    get crmFiles() {
      return crmFiles()
    },
    get relations() {
      return relations()
    },
    get decisionRequests() {
      return decisionRequests()
    },
    get templates() {
      return templates()
    },
    get records() {
      return records()
    },
    get memories() {
      return memories()
    },
    decisionPolicy: context.decisions ?? DEFAULT_DECISION_POLICY,
    get proposedActions() {
      return proposedActions()
    },
    get agentActions() {
      return agentActions()
    },
    get meetings() {
      return meetings()
    },
    get mail() {
      return mail()
    },

    forAccount: (key) =>
      bindAccount(store, key, areas, {
        accountPk: () => accounts.findAccountPk(context, key),
        attachmentAccount: (attachmentPk) => attachmentTexts.accountOf(context, attachmentPk),
      }),
    close: async () => database.close(),
  }
  return store
}

export * from "./exports.js"
export type { MessageStore, MessageStoreAreas, MessageStoreCore } from "./message-store.js"
