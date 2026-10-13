import { CliError } from "@wirecat/cli-base"
import type { Command } from "commander"

type WithUnknown = { unknownOption(flag: string): void }

/**
 * Options that are gone fail with what replaced them, not commander's bare "unknown option" — and without an
 * alias that keeps them working (STANDARD.md, Command names rule 9).
 */
export const removedOptions = (command: Command, replaced: Readonly<Record<string, string>>): Command => {
  const unknown = (command as unknown as WithUnknown).unknownOption.bind(command)
  ;(command as unknown as WithUnknown).unknownOption = (flag: string) => {
    const name = flag.split("=")[0] as string
    const instead = replaced[name]
    if (instead !== undefined) throw new CliError("validation_error", `${name} was removed — ${instead}`)
    unknown(flag)
  }
  return command
}
