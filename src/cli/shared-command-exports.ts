import { appDoctorCommand as appDoctorCommandDefinition } from "./app-doctor-command.js"
import { appMcpCommand as appMcpCommandDefinition } from "./app-mcp-command.js"
import {
  botAdminsCommand as botAdminsCommandDefinition,
  botMembersCommand as botMembersCommandDefinition,
} from "./bot/admins.js"
import { generatedApiCommand as generatedApiCommandDefinition } from "./bot/api.js"
import { botCommand as botCommandDefinition } from "./bot/command.js"
import { botMcpCommand as botMcpCommandDefinition } from "./bot/mcp.js"
import { botMessagesCommand as botMessagesCommandDefinition } from "./bot/messages.js"
import { commandsCommand as commandsCommandDefinition } from "./commands-command.js"
import { configCommand as configCommandDefinition } from "./config-command.js"
import { honoursDryRun } from "./dry-run-guard.js"
import { guideCommand as guideCommandDefinition } from "./guide.js"
import { addMeetingBatchCommand as addMeetingBatchCommandDefinition } from "./meeting-batch.js"
import { addMeetingPreparationCommand as addMeetingPreparationCommandDefinition } from "./meeting-preparation-command.js"
import { addMeetingProjectCandidatesCommand as addMeetingProjectCandidatesCommandDefinition } from "./meeting-project-candidates-command.js"
import { addMeetingSeriesInventoryCommand as addMeetingSeriesInventoryCommandDefinition } from "./meeting-series-inventory-command.js"
import { accountCommand as accountCommandDefinition } from "./messenger/account-command.js"
import { storeCommand as storeCommandDefinition } from "./messenger/archive-commands.js"
import { attachmentsCommand as attachmentsCommandDefinition } from "./messenger/attachments-command.js"
import { chatsCommand as chatsCommandDefinition } from "./messenger/chats-command.js"
import { markReadCommand as markReadCommandDefinition } from "./messenger/chats-read-command.js"
import { completeCommand as completeCommandDefinition } from "./messenger/complete-command.js"
import { contactsCommand as contactsCommandDefinition } from "./messenger/contacts-command.js"
import { conversationsCommand as conversationsCommandDefinition } from "./messenger/conversations-command.js"
import { doctorCommand as doctorCommandDefinition } from "./messenger/doctor-command.js"
import { floodCommand as floodCommandDefinition } from "./messenger/flood-command.js"
import {
  recipientsCommand as recipientsCommandDefinition,
  sendsCommand as sendsCommandDefinition,
} from "./messenger/guard-commands.js"
import { imagesCommand as imagesCommandDefinition } from "./messenger/images-command.js"
import { inboxCommand as inboxCommandDefinition } from "./messenger/inbox.js"
import { mcpCommand as mcpCommandDefinition } from "./messenger/mcp-command.js"
import { mentionsCommand as mentionsCommandDefinition } from "./messenger/mentions-command.js"
import {
  messagesCommand as messagesCommandDefinition,
  sendCommand as sendCommandDefinition,
} from "./messenger/messages-command.js"
import { deleteCommand as deleteCommandDefinition } from "./messenger/messages-delete-command.js"
import { editCommand as editCommandDefinition } from "./messenger/messages-edit-command.js"
import { forwardCommand as forwardCommandDefinition } from "./messenger/messages-forward-command.js"
import {
  pinCommand as pinCommandDefinition,
  starCommands as starCommandsDefinition,
  unpinCommand as unpinCommandDefinition,
} from "./messenger/messages-pin-command.js"
import { metadataCommand as metadataCommandDefinition } from "./messenger/metadata-command.js"
import { modelsCommand as modelsCommandDefinition } from "./messenger/models-command.js"
import { pollsCommand as pollsCommandDefinition } from "./messenger/polls-command.js"
import { projectsCommand as projectsCommandDefinition } from "./messenger/projects-command.js"
import { reactionsCommand as reactionsCommandDefinition } from "./messenger/reactions-command.js"
import {
  callsCommand as callsCommandDefinition,
  stickersCommand as stickersCommandDefinition,
} from "./messenger/records-command.js"
import { repliesCommand as repliesCommandDefinition } from "./messenger/replies-command.js"
import { reviewCommand as reviewCommandDefinition } from "./messenger/review.js"
import {
  scheduleCommand as scheduleCommandDefinition,
  scheduleCommandFor as scheduleCommandForDefinition,
} from "./messenger/schedule-command.js"
import { searchCommand as searchCommandDefinition } from "./messenger/search-command.js"
import { searchesCommand as searchesCommandDefinition } from "./messenger/searches-command.js"
import { serveCommand as serveCommandDefinition } from "./messenger/serve-command.js"
import { serverCommand as serverCommandDefinition } from "./messenger/server-command.js"
import { statsCommand as statsCommandDefinition } from "./messenger/stats-command.js"
import { tagsCommand as tagsCommandDefinition } from "./messenger/tags-command.js"
import {
  tasksCommand as tasksCommandDefinition,
  tasksStatsCommand as tasksStatsCommandDefinition,
} from "./messenger/tasks-command.js"
import { topicsCommand as topicsCommandDefinition } from "./messenger/topics-command.js"
import { watchCommand as watchCommandDefinition } from "./messenger/watch-command.js"
import { runsCommand as runsCommandDefinition } from "./runs/command.js"
import { sharedCommand as protectedCommand } from "./shared-contracts.js"

import { skillCommand as skillCommandDefinition } from "./skill-command.js"
import { upgradeCommand as upgradeCommandDefinition } from "./upgrade-command.js"

const sharedCommand: typeof protectedCommand = (factory) => honoursDryRun(protectedCommand(factory))

export const appDoctorCommand = sharedCommand(appDoctorCommandDefinition)
export const appMcpCommand = sharedCommand(appMcpCommandDefinition)
export const botAdminsCommand = sharedCommand(botAdminsCommandDefinition)
export const botMembersCommand = sharedCommand(botMembersCommandDefinition)
export const generatedApiCommand = sharedCommand(generatedApiCommandDefinition)
export const botCommand = sharedCommand(botCommandDefinition)
export const botMcpCommand = sharedCommand(botMcpCommandDefinition)
export const botMessagesCommand = sharedCommand(botMessagesCommandDefinition)
export const commandsCommand = sharedCommand(commandsCommandDefinition)
export const configCommand = sharedCommand(configCommandDefinition)
export const guideCommand = sharedCommand(guideCommandDefinition)
export const addMeetingBatchCommand = sharedCommand(addMeetingBatchCommandDefinition)
export const addMeetingPreparationCommand = sharedCommand(addMeetingPreparationCommandDefinition)
export const addMeetingProjectCandidatesCommand = sharedCommand(addMeetingProjectCandidatesCommandDefinition)
export const addMeetingSeriesInventoryCommand = sharedCommand(addMeetingSeriesInventoryCommandDefinition)
export const accountCommand = sharedCommand(accountCommandDefinition)
export const storeCommand = sharedCommand(storeCommandDefinition)
export const attachmentsCommand = sharedCommand(attachmentsCommandDefinition)
export const chatsCommand = sharedCommand(chatsCommandDefinition)
export const markReadCommand = sharedCommand(markReadCommandDefinition)
export const completeCommand = sharedCommand(completeCommandDefinition)
export const contactsCommand = sharedCommand(contactsCommandDefinition)
export const conversationsCommand = sharedCommand(conversationsCommandDefinition)
export const doctorCommand = sharedCommand(doctorCommandDefinition)
export const floodCommand = sharedCommand(floodCommandDefinition)
export const recipientsCommand = sharedCommand(recipientsCommandDefinition)
export const sendsCommand = sharedCommand(sendsCommandDefinition)
export const imagesCommand = sharedCommand(imagesCommandDefinition)
export const inboxCommand = sharedCommand(inboxCommandDefinition)
export const mcpCommand = sharedCommand(mcpCommandDefinition)
export const mentionsCommand = sharedCommand(mentionsCommandDefinition)
export const messagesCommand = sharedCommand(messagesCommandDefinition)
export const sendCommand = sharedCommand(sendCommandDefinition)
export const deleteCommand = sharedCommand(deleteCommandDefinition)
export const editCommand = sharedCommand(editCommandDefinition)
export const forwardCommand = sharedCommand(forwardCommandDefinition)
export const pinCommand = sharedCommand(pinCommandDefinition)
export const starCommands = sharedCommand(starCommandsDefinition)
export const unpinCommand = sharedCommand(unpinCommandDefinition)
export const metadataCommand = sharedCommand(metadataCommandDefinition)
export const modelsCommand = sharedCommand(modelsCommandDefinition)
export const pollsCommand = sharedCommand(pollsCommandDefinition)
export const reactionsCommand = sharedCommand(reactionsCommandDefinition)
export const callsCommand = sharedCommand(callsCommandDefinition)
export const stickersCommand = sharedCommand(stickersCommandDefinition)
export const repliesCommand = sharedCommand(repliesCommandDefinition)
export const reviewCommand = sharedCommand(reviewCommandDefinition)
export const scheduleCommand = sharedCommand(scheduleCommandDefinition)
export const scheduleCommandFor = sharedCommand(scheduleCommandForDefinition)
export const searchCommand = sharedCommand(searchCommandDefinition)
export const searchesCommand = sharedCommand(searchesCommandDefinition)
export const serveCommand = sharedCommand(serveCommandDefinition)
export const serverCommand = sharedCommand(serverCommandDefinition)
export const statsCommand = sharedCommand(statsCommandDefinition)
export const tagsCommand = sharedCommand(tagsCommandDefinition)
export const tasksCommand = sharedCommand(tasksCommandDefinition)
export const tasksStatsCommand = sharedCommand(tasksStatsCommandDefinition)
export const topicsCommand = sharedCommand(topicsCommandDefinition)
export const projectsCommand = sharedCommand(projectsCommandDefinition)
export const watchCommand = sharedCommand(watchCommandDefinition)
export const runsCommand = sharedCommand(runsCommandDefinition)
export const skillCommand = sharedCommand(skillCommandDefinition)
export const upgradeCommand = sharedCommand(upgradeCommandDefinition)

import { modelCatalogueCommand as modelCatalogueDefinition } from "./model-catalogue-command.js"
export const modelCatalogueCommand = sharedCommand(modelCatalogueDefinition)
