import { fileURLToPath } from "node:url"
import { CliError } from "@wirecat/cli-base"
import { WCAT_SCENARIOS } from "../cli/guide.js"
import { addMeetingProjectCandidatesCommand } from "../cli/meeting-project-candidates-command.js"
import { addMeetingSeriesInventoryCommand } from "../cli/meeting-series-inventory-command.js"
import type { Messenger } from "../cli/messenger/context.js"
import type { ProgramDefinition } from "../cli/program.js"
import { settingsFor } from "../cli/settings.js"
import {
  accountCommand,
  attachmentsCommand,
  botCommand,
  chatsCommand,
  commandsCommand,
  completeCommand,
  configCommand,
  contactsCommand,
  conversationsCommand,
  doctorCommand,
  floodCommand,
  guideCommand,
  imagesCommand,
  inboxCommand,
  mcpCommand,
  mentionsCommand,
  messagesCommand,
  metadataCommand,
  modelsCommand,
  pollsCommand,
  reactionsCommand,
  recipientsCommand,
  repliesCommand,
  reviewCommand,
  runsCommand,
  scheduleCommand,
  searchCommand,
  searchesCommand,
  sendsCommand,
  serveCommand,
  serverCommand,
  skillCommand,
  statsCommand,
  storeCommand,
  tagsCommand,
  tasksCommand,
  templatesCommand,
  topicsCommand,
  watchCommand,
} from "../cli/shared-command-exports.js"
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
  chatArchive: true,
  chatPin: true,
  chatMarkUnread: true,
  messageStars: true,
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
  stickerFileBytes: 500 * 1024,
  groupPhoto: true,
  groupPhotoRemoval: true,
  accountRemoval: { signOut: refuse },
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
    guideCommand(app, {
      directory: fileURLToPath(new URL("../cli/fixtures/scenarios", import.meta.url)),
      worksWith: [WCAT_SCENARIOS.personBrief],
    }),
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
    program.addCommand(templatesCommand(app, { env: () => ({}), output: () => undefined, diagnostic: () => undefined }))
  },
}
