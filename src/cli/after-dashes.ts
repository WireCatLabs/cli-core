import { metaOf } from "@wirecat/cli-base/commands"
import type { Command, Option } from "commander"

declare module "@wirecat/cli-base/commands" {
  interface CommandMeta {
    /**
     * Every word after `--` stays a positional, even one spelled as this command's option: the command takes free
     * text (a message, a title, another program's arguments), where `--json` may be the text itself.
     */
    literal_after_dashes?: boolean
  }
}

const optionsOf = (command: Command): Map<string, Option> => {
  const found = new Map<string, Option>()
  for (let at: Command | null = command; at; at = at.parent)
    for (const option of at.options) if (option.long && !found.has(option.long)) found.set(option.long, option)
  return found
}

/**
 * `messages sync -- -100 --json` as `messages sync --json -- -100`: agents copy `-- <id> --json` from old skill
 * text, and a negative id needs no `--` anyway. Only a word that is exactly one of the command's options moves, with
 * the value it takes; a command marked `literal_after_dashes` keeps every word after `--` as it is.
 */
export const liftOptionsAfterDashes = (
  argv: readonly string[],
  target: (words: string[]) => Command | undefined,
): string[] => {
  const end = argv.indexOf("--")
  if (end < 0) return [...argv]
  const command = target(argv.slice(0, end))
  if (!command || metaOf(command).literal_after_dashes) return [...argv]
  const options = optionsOf(command)
  const moved: string[] = []
  const kept: string[] = []
  for (let index = end + 1; index < argv.length; index++) {
    const word = argv[index] as string
    const equals = word.indexOf("=")
    const option = word.startsWith("--") ? options.get(equals < 0 ? word : word.slice(0, equals)) : undefined
    if (!option) {
      kept.push(word)
      continue
    }
    moved.push(word)
    // An optional value is left alone: after `--` the next word is as likely the positional as the value.
    if (option.required && equals < 0 && index + 1 < argv.length) moved.push(argv[++index] as string)
  }
  if (moved.length === 0) return [...argv]
  return [...argv.slice(0, end), ...moved, "--", ...kept]
}
