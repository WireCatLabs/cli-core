import type { Command } from "commander"
import { scheduleCommandFor } from "../schedule/schedule-command.js"
import { type Messenger, messengerContext } from "./context.js"

export { type ScheduleHost, scheduleCommandFor } from "../schedule/schedule-command.js"

export const scheduleCommand = (messenger: Messenger): Command =>
  scheduleCommandFor({
    app: messenger.app,
    context: (command, resolving) => messengerContext(command, messenger, resolving),
  })
