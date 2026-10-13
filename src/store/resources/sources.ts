import type { SourcesStore } from "../contracts/sources.js"
import { agentActionsStoreOver } from "../sqlite/agent-actions.js"
import { type BotUpdateStore, botUpdateStoreOver } from "../sqlite/bot-updates.js"
import { factsStoreOver } from "../sqlite/facts.js"
import { type InvolvementStore, involvementStoreOver } from "../sqlite/involvements.js"
import { knowledgeStoreOver } from "../sqlite/knowledge.js"
import { meetingVectorsOver } from "../sqlite/meeting-vectors.js"
import { meetingStoreOver } from "../sqlite/meetings.js"
import { memoriesStoreOver } from "../sqlite/memories.js"
import { noteSearchOver } from "../sqlite/note-search.js"
import { notesStoreOver } from "../sqlite/notes.js"
import { proposedActionsStoreOver } from "../sqlite/proposed-actions.js"
import { taskStoreOver } from "../sqlite/tasks.js"

import type { StoreRuntime } from "./runtime.js"

export const sourcesStoreOver = ({
  context,
  pruneLogsWhenDue,
  mailOf,
}: Pick<StoreRuntime, "context" | "pruneLogsWhenDue" | "mailOf">): SourcesStore => {
  let botUpdates: BotUpdateStore | undefined

  let involvements: InvolvementStore | undefined

  let tasks: SourcesStore["tasks"] | undefined

  let knowledge: SourcesStore["knowledge"] | undefined

  let notes: SourcesStore["notes"] | undefined

  let facts: SourcesStore["facts"] | undefined

  let memories: SourcesStore["memories"] | undefined

  let proposedActions: SourcesStore["proposedActions"] | undefined

  let agentActions: SourcesStore["agentActions"] | undefined

  let meetings: SourcesStore["meetings"] | undefined
  return {
    meetingVectors: meetingVectorsOver(context),

    // Built on first use: an area that prepares its statements must not stop the store opening for the rest.
    get botUpdates() {
      botUpdates ??= botUpdateStoreOver(context, pruneLogsWhenDue)
      return botUpdates
    },

    get involvements() {
      involvements ??= involvementStoreOver(context)
      return involvements
    },

    get tasks() {
      tasks ??= taskStoreOver(context)
      return tasks
    },

    get knowledge() {
      knowledge ??= knowledgeStoreOver(context)
      return knowledge
    },

    get notes() {
      notes ??= { ...notesStoreOver(context), ...noteSearchOver(context) }
      return notes
    },

    get facts() {
      facts ??= factsStoreOver(context)
      return facts
    },

    get memories() {
      memories ??= memoriesStoreOver(context)
      return memories
    },

    get proposedActions() {
      proposedActions ??= proposedActionsStoreOver(context)
      return proposedActions
    },

    get agentActions() {
      agentActions ??= agentActionsStoreOver(context, pruneLogsWhenDue)
      return agentActions
    },

    get meetings() {
      meetings ??= meetingStoreOver(context)
      return meetings
    },

    get mail() {
      return mailOf()
    },
  }
}
