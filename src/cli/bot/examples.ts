import type { BotMessenger } from "./port.js"

/** Help examples for a shared bot command, in the calling CLI's own words, for a bot profile named `sales`. */
export const botExamples = (bot: BotMessenger, ...lines: string[]): string[] =>
  lines.map((line) => `${bot.app.command} sales bot ${line}`)
