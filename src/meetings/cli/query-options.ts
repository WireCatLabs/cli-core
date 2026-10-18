import type { Command } from "commander"

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
    const typo = parsed.unknown.slice(0, end < 0 ? undefined : end).find((word) => word.startsWith("--"))
    if (typo !== undefined) {
      command.allowUnknownOption(false)
      ;(command as unknown as { unknownOption: (flag: string) => never }).unknownOption(typo)
    }
    if (end >= 0) parsed.unknown.splice(end, 1)
    return parsed
  }
  return command
}
