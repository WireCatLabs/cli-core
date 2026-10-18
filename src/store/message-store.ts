import { type Area, bindAccount, type Keyed } from "./account-store.js"
import { type AccountAccounts, accountAccountsOver, accountsStoreOver } from "./accounts.js"
import { type AccountAttachments, accountAttachmentsOver, attachmentsStoreOver } from "./attachments.js"
import { type ChatsStore, chatsStoreOver } from "./chats.js"
import { type ConversationsStore, conversationsStoreOver } from "./conversations.js"
import { type AccountCounters, accountCountersOver, countersStoreOver } from "./counters.js"
import { type AccountMentions, accountMentionsOver, mentionsStoreOver } from "./mentions.js"
import { type AccountMessages, accountMessagesOver, messagesStoreOver } from "./messages.js"
import { type AccountPeople, accountPeopleOver, peopleStoreOver } from "./people.js"
import { queriesStoreOver } from "./queries.js"
import { type RosterStore, rosterStoreOver } from "./roster.js"
import { searchIndexStoreOver } from "./search-index.js"
import { searchesStoreOver } from "./searches.js"
import * as accounts from "./sqlite/accounts.js"
import { agentActionsStoreOver } from "./sqlite/agent-actions.js"
import * as attachmentTexts from "./sqlite/attachment-texts.js"
import { botUpdateStoreOver } from "./sqlite/bot-updates.js"
import { catalogStoreOver } from "./sqlite/catalog.js"
import { contextEvidenceOver } from "./sqlite/context-evidence.js"
import { mailStoreOver } from "./sqlite/emails.js"
import { factsStoreOver } from "./sqlite/facts.js"
import { involvementStoreOver } from "./sqlite/involvements.js"
import { knowledgeStoreOver } from "./sqlite/knowledge.js"
import { logPruner } from "./sqlite/log-pruning.js"
import { meetingFindingsStoreOver } from "./sqlite/meeting-findings.js"
import { meetingVectorsOver } from "./sqlite/meeting-vectors.js"
import { meetingStoreOver } from "./sqlite/meetings.js"
import { memoriesStoreOver } from "./sqlite/memories.js"
import { sourceMentionStoreOver } from "./sqlite/mention-sources.js"
import { noteSearchOver } from "./sqlite/note-search.js"
import { notesStoreOver } from "./sqlite/notes.js"
import type { StoreContext } from "./sqlite/open.js"
import { openStoreContext, type StoreOptions } from "./sqlite/open-store.js"
import { proposedActionsStoreOver } from "./sqlite/proposed-actions.js"
import * as stems from "./sqlite/stems.js"
import { taskStoreOver } from "./sqlite/tasks.js"
import type { MessageStore } from "./store.js"
import { type SyncStore, syncStoreOver } from "./sync.js"
import { type TagsStore, tagsStoreOver } from "./tags.js"
import { type AccountVectors, accountVectorsOver, vectorsStoreOver } from "./vectors.js"

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
  return () => {
    built ??= build()
    return built
  }
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
  const searches = once(() => searchesStoreOver(context))
  const queries = once(() => queriesStoreOver(context, stemmerFor))
  const searchIndex = once(() => searchIndexStoreOver(context))
  const botUpdates = once(() => botUpdateStoreOver(context, pruneLogsWhenDue))
  const involvements = once(() => involvementStoreOver(context))
  const tasks = once(() => taskStoreOver(context))
  const sourceMentions = once(() => sourceMentionStoreOver(context))
  const knowledge = once(() => knowledgeStoreOver(context))
  const notes = once(() => ({ ...notesStoreOver(context), ...noteSearchOver(context) }))
  const catalog = once(() => catalogStoreOver(context))
  const meetingFindings = once(() => meetingFindingsStoreOver(context))
  const facts = once(() => factsStoreOver(context))
  const memories = once(() => memoriesStoreOver(context))
  const proposedActions = once(() => proposedActionsStoreOver(context))
  const agentActions = once(() => agentActionsStoreOver(context, pruneLogsWhenDue))
  const meetings = once(() => meetingStoreOver(context))

  const store: MessageStore = {
    get contextEvidence() {
      return contextEvidence()
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
    get meetingFindings() {
      return meetingFindings()
    },
    get facts() {
      return facts()
    },
    get memories() {
      return memories()
    },
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
