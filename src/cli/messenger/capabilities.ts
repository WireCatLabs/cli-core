import { commandCapabilities } from "../../ports/capabilities.js"
import type { Messenger } from "./context.js"

export { commandCapabilities } from "../../ports/capabilities.js"

export const topicOption = <T extends { option(flags: string, description: string): T }>(
  command: T,
  provider: Messenger,
  description: string,
  action: "list" | "send" | "markRead" | "pollCreate",
): T => (commandCapabilities(provider).topicOptions[action] ? command.option("--topic <id>", description) : command)
