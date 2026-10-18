import { appendFileSync } from "node:fs"
import type { Command } from "commander"

/**
 * One JSON line per parsed command — its path and the long options given on the command line — appended to `file`,
 * for a test matrix to check what every row really ran. Never an argument's value: those can be a message.
 */
export const logParsedArgv = (file: string, action: Command): void => {
  const words: string[] = []
  const options: string[] = []
  for (let at: Command | null = action; at; at = at.parent) {
    if (at.parent) words.unshift(at.name())
    for (const option of at.options) {
      const key = option.attributeName()
      if (at.getOptionValueSource(key) !== "cli" || !option.long) continue
      if (option.negate === (at.getOptionValue(key) === false)) options.push(option.long)
    }
  }
  appendFileSync(file, `${JSON.stringify({ command: words.join(" "), options })}\n`)
}

export const logVersion = (file: string): void => {
  appendFileSync(file, `${JSON.stringify({ command: "", options: ["--version"] })}\n`)
}
