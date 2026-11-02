import type { Command } from "commander"

/**
 * A flag a command does not take, but an agent is likely to type, fails with what to type instead rather than
 * commander's bare "unknown option".
 */
export const withOptionHints = (command: Command, hints: Readonly<Record<string, string>>): Command => {
  const unknown = command as unknown as { unknownOption: (flag: string) => never }
  const fallback = unknown.unknownOption.bind(command)
  unknown.unknownOption = (flag) => {
    const hint = hints[flag.split("=")[0] as string]
    if (hint === undefined) return fallback(flag)
    return command.error(`unknown option '${flag}' — ${hint}`, { code: "commander.unknownOption" })
  }
  return command
}
