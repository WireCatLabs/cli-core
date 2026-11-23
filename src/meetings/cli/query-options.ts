import type { Command } from "commander"
import { helpOptionOf, rejectUnknownOption } from "../../cli/commander-internals.js"

/**
 * Lets a query's `-kind:channel` through as a negated term while a mistyped `--limt` still fails as an unknown
 * option, with commander's suggestion; after `--` every word is query.
 */
export const queryWordsAfterOptions = (command: Command): Command => {
  command.allowUnknownOption()
  const parse = command.parseOptions.bind(command)
  command.parseOptions = (args) => {
    const parsed = parse(args)
    const end = parsed.unknown.indexOf("--")
    // Commander looks for --help in what parseOptions leaves unknown, after it returns.
    const help = helpOptionOf(command)
    const typo = parsed.unknown
      .slice(0, end < 0 ? undefined : end)
      .find((word) => word.startsWith("--") && !help?.is(word))
    if (typo !== undefined) {
      command.allowUnknownOption(false)
      rejectUnknownOption(command, typo)
    }
    if (end >= 0) parsed.unknown.splice(end, 1)
    return parsed
  }
  return command
}
