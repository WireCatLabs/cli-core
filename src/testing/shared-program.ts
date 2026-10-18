import { CliError } from "@wirecat/cli-base"
import { botCommand } from "../cli/bot/command.js"
import { commandsCommand } from "../cli/commands-command.js"
import { configCommand } from "../cli/config-command.js"
import { addMeetingProjectCandidatesCommand } from "../cli/meeting-project-candidates-command.js"
import { addMeetingSeriesInventoryCommand } from "../cli/meeting-series-inventory-command.js"
import { accountCommand } from "../cli/messenger/account-command.js"
import { storeCommand } from "../cli/messenger/archive-commands.js"
import { attachmentsCommand } from "../cli/messenger/attachments-command.js"
import { chatsCommand } from "../cli/messenger/chats-command.js"
import { completeCommand } from "../cli/messenger/complete-command.js"
import { contactsCommand } from "../cli/messenger/contacts-command.js"
import type { Messenger } from "../cli/messenger/context.js"
import { conversationsCommand } from "../cli/messenger/conversations-command.js"
import { doctorCommand } from "../cli/messenger/doctor-command.js"
import { floodCommand } from "../cli/messenger/flood-command.js"
import { recipientsCommand, sendsCommand } from "../cli/messenger/guard-commands.js"
import { imagesCommand } from "../cli/messenger/images-command.js"
import { inboxCommand } from "../cli/messenger/inbox.js"
import { mcpCommand } from "../cli/messenger/mcp-command.js"
import { mentionsCommand } from "../cli/messenger/mentions-command.js"
import { messagesCommand } from "../cli/messenger/messages-command.js"
import { metadataCommand } from "../cli/messenger/metadata-command.js"
import { modelsCommand } from "../cli/messenger/models-command.js"
import { pollsCommand } from "../cli/messenger/polls-command.js"
import { reactionsCommand } from "../cli/messenger/reactions-command.js"
import { repliesCommand } from "../cli/messenger/replies-command.js"
import { reviewCommand } from "../cli/messenger/review.js"
import { scheduleCommand } from "../cli/messenger/schedule-command.js"
import { searchCommand } from "../cli/messenger/search-command.js"
import { searchesCommand } from "../cli/messenger/searches-command.js"
import { serveCommand } from "../cli/messenger/serve-command.js"
import { serverCommand } from "../cli/messenger/server-command.js"
import { statsCommand } from "../cli/messenger/stats-command.js"
import { tagsCommand } from "../cli/messenger/tags-command.js"
import { tasksCommand } from "../cli/messenger/tasks-command.js"
import { topicsCommand } from "../cli/messenger/topics-command.js"
import { watchCommand } from "../cli/messenger/watch-command.js"
import type { ProgramDefinition } from "../cli/program.js"
import { runsCommand } from "../cli/runs/command.js"
import { settingsFor } from "../cli/settings.js"
import { skillCommand } from "../cli/skill-command.js"
import { GROUP_SETTINGS } from "../domain/models.js"

export const app = {
  command: "chat",
  appName: "chat-cli",
  envPrefix: "CHAT",
  description: "synthetic",
  version: "1.0.0",
}
const refuse = async (): Promise<never> => {
  throw new CliError("network_error", "no connection in this test")
}
const config = settingsFor(app)
export const messenger: Messenger = {
  app,
  provider: "chat",
  chatArgument: "a chat",
  resolveSettings: config.resolveSettings,
  connect: refuse,
  groupSettings: [...GROUP_SETTINGS, "joinApproval", "onlyAdminsSend", "onlyAdminsEditInfo", "disappearingSeconds"],
  chatPin: true,
  privacy: true,
  privacySettings: [
    "findByPhone",
    "phoneNumber",
    "calls",
    "chatInvites",
    "hideOnline",
    "readReceipts",
    "profilePhoto",
    "about",
    "lastSeen",
  ],
  chatMute: true,
<<<<<<< HEAD
  stickerFileBytes: 500 * 1024,
||||||| parent of 4fec7028 (feat(chats): chats update --remove-photo, and a messenger's own photo types)
=======
  groupPhoto: true,
  groupPhotoRemoval: true,
>>>>>>> 4fec7028 (feat(chats): chats update --remove-photo, and a messenger's own photo types)
}

/** Every shared command over `over`, as tg, max and wa mount them between them; its switches drop what they drop. */
export const sharedCommands = (over: Messenger = messenger) => {
  const messenger = over
  const { app } = over
  const config = settingsFor(app)
  return [
    accountCommand(messenger),
    attachmentsCommand(messenger),
    chatsCommand(messenger),
    commandsCommand(app),
    completeCommand(messenger, config),
    configCommand(app, config),
    contactsCommand(messenger),
    conversationsCommand(messenger),
    doctorCommand(messenger),
    floodCommand(messenger),
    imagesCommand(messenger),
    inboxCommand(messenger),
    mcpCommand(messenger),
    mentionsCommand(messenger),
    messagesCommand(messenger),
    metadataCommand(messenger),
    modelsCommand(messenger),
    pollsCommand(messenger),
    reactionsCommand(messenger),
    recipientsCommand(messenger),
    repliesCommand(messenger),
    reviewCommand(messenger),
    runsCommand(app),
    scheduleCommand(messenger),
    searchCommand(messenger, { topics: true }),
    searchesCommand(messenger),
    sendsCommand(messenger),
    serveCommand(messenger),
    serverCommand(messenger),
    skillCommand(app, new URL("../../skills/follow-ups/SKILL.md", import.meta.url)),
    statsCommand(messenger),
    storeCommand(messenger),
    tagsCommand(messenger),
    tasksCommand(messenger),
    topicsCommand(messenger),
    watchCommand(messenger),
    botCommand({
      app,
      provider: "chat",
      resolveSettings: config.resolveSettings,
      connect: refuse,
      mcp: { program: refuse },
    }),
  ]
}

/** A messenger that mounts every shared command, as tg, max and wa do between them. */
export const sharedProgram: ProgramDefinition = {
  app,
  commands: () => sharedCommands(),
  configure: (program) => {
    program.command("meetings").description("stored meetings")
    addMeetingSeriesInventoryCommand(program, { read: refuse, output: () => undefined, signal: () => undefined })
    addMeetingProjectCandidatesCommand(program, { read: refuse, output: () => undefined, signal: () => undefined })
  },
}
