import { metaOf } from "@wirecat/cli-base/commands"
import * as v from "valibot"
import type { Messenger } from "../cli/messenger/context.js"
import { COMMAND_NEEDS } from "../cli/messenger/lacks.js"
import { commandAt } from "../cli/steps.js"
import { type AnyTool, commandOf } from "./tool.js"

type Command = Parameters<typeof commandAt>[0]

import { accountTools } from "./tools/account.js"
import { adminTools } from "./tools/admin.js"
import { adminStatisticsTools } from "./tools/admin-statistics.js"
import { attachmentsTools } from "./tools/attachments.js"
import { chatsTools } from "./tools/chats.js"
import { chatsReadTools } from "./tools/chats-read.js"
import { contactsTools } from "./tools/contacts.js"
import { contactWriteTools } from "./tools/contacts-write.js"
import { conversationsTools } from "./tools/conversations.js"
import { folderTools } from "./tools/folders.js"
import { inboxTools } from "./tools/inbox.js"
import { messagesTools } from "./tools/messages.js"
import { messageActionTools } from "./tools/messages-actions.js"
import { messageDeleteTools } from "./tools/messages-delete.js"
import { messagesPhotoTools } from "./tools/messages-photo.js"
import { messageSendTools } from "./tools/messages-send.js"
import { messagesTranscribeTools } from "./tools/messages-transcribe.js"
import { moderationTools } from "./tools/moderation.js"
import { pollReadTools, pollWriteTools } from "./tools/polls.js"
import { privatePeopleTools } from "./tools/private-people.js"
import { rankingTools } from "./tools/rankings.js"
import { reactionTools } from "./tools/reactions.js"
import { reviewTools } from "./tools/review.js"
import { runsTools } from "./tools/runs.js"
import { searchTools } from "./tools/search-tools.js"
import { searchesTools } from "./tools/searches.js"
import { statsTools } from "./tools/stats.js"
import { storeTools } from "./tools/store.js"
import { tagsTools } from "./tools/tags.js"
import { tasksTools } from "./tools/tasks.js"
import { topicsTools, topicWriteTools } from "./tools/topics.js"

/**
 * The read tools, each answering what its command's `--json` prints. Named `<cli>_<command words>`,
 * so `tg_chats_list` is `tg chats list`. A new resource is a file in `tools/` and a line here.
 */
export const readTools = (messenger: Messenger): Record<string, AnyTool> => ({
  ...runsTools(messenger),
  ...inboxTools(messenger),
  ...reviewTools(messenger),
  ...topicsTools(messenger),
  ...accountTools(messenger),
  ...chatsTools(messenger),
  ...statsTools(messenger),
  ...storeTools(messenger),
  ...contactsTools(messenger),
  ...messagesTools(messenger),
  ...searchTools(messenger),
  ...rankingTools(messenger),
  ...adminStatisticsTools(messenger),
  ...conversationsTools(messenger),
  ...pollReadTools(messenger),
  ...messagesPhotoTools(messenger),
  ...messagesTranscribeTools(messenger),
})

/** Separate from sending: the other side sees this deliberate mark-read operation. */
export const markReadTools = (messenger: Messenger): Record<string, AnyTool> => chatsReadTools(messenger)

/** The owner's own copy, never for everyone — that is the command's alone. */
export const deleteTools = (messenger: Messenger): Record<string, AnyTool> => messageDeleteTools(messenger)

/** The writes others see, offered by the profile's permissions like every write. */
export const sendTools = (messenger: Messenger): Record<string, AnyTool> => ({
  ...adminTools(messenger),
  ...topicWriteTools(messenger),
  ...folderTools(messenger),
  ...contactWriteTools(messenger),
  ...moderationTools(messenger),
  ...messageSendTools(messenger),
  ...messageActionTools(messenger),
  ...reactionTools(messenger),
  ...pollWriteTools(messenger),
})

/** The owner's own records in the local store — tags, saved searches, files' text — read and written; never sent. */
export const localTools = (messenger: Messenger): Record<string, AnyTool> => ({
  ...privatePeopleTools(messenger),
  ...tagsTools(messenger),
  ...searchesTools(messenger),
  ...tasksTools(messenger),
  ...attachmentsTools(messenger),
})

/** Every tool a personal server mounts, its input strict: an obsolete argument fails instead of being dropped. */
export const personalMcpTools = (messenger: Messenger): Record<string, AnyTool> =>
  Object.fromEntries(
    Object.entries({
      ...readTools(messenger),
      ...localTools(messenger),
      ...sendTools(messenger),
      ...markReadTools(messenger),
      ...deleteTools(messenger),
    }).map(([name, definition]) => [name, { ...definition, input: v.strictObject(definition.input.entries) }]),
  )

/**
 * The tools this CLI's own command tree answers: a tool whose command its switches left unmounted, whose one adapter
 * method it lacks, or which is kept off MCP with `mcp: false`, is not offered — an agent is not handed what the CLI
 * does not have.
 */
export const mountedMcpTools = (root: Command, messenger: Messenger): Record<string, AnyTool> =>
  Object.fromEntries(
    Object.entries(personalMcpTools(messenger)).filter(([name, definition]) => {
      if (definition.agentOnly) return true
      const path = commandOf(name, definition)
      const command = commandAt(root, path)
      const need = COMMAND_NEEDS[path]
      return command !== undefined && !offMcp(command) && !(need && messenger.lacks?.includes(need[0]))
    }),
  )

/** `mcp: false` on a command or any group above it. */
const offMcp = (command: Command): boolean => {
  for (let at: Command | null = command; at; at = at.parent) if (metaOf(at).mcp === false) return true
  return false
}
