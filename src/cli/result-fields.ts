import { CliError, fieldsOf as coreFieldsOf, projectFields as coreProjectFields } from "@wirecat/cli-base"
import type { CommandInfo } from "@wirecat/cli-base/commands"

const named = <T>(work: () => T): T => {
  try {
    return work()
  } catch (error) {
    if (error instanceof CliError && error.code === "validation_error")
      throw new CliError("validation_error", "--json takes comma-separated field paths, for example --json=id,text", {
        param: "--json",
      })
    throw error
  }
}

export const fieldsOf = (value: string): string[] => named(() => coreFieldsOf(value))

const projectCommands = (commands: readonly CommandInfo[], fields: readonly string[]): unknown[] =>
  commands.map((command) => ({
    ...(coreProjectFields(command, fields) as Record<string, unknown>),
    path: command.path,
    name: command.name,
    origin: command.origin,
    effects: command.effects,
    commands: projectCommands(command.commands, fields),
  }))

export const projectFields = (value: unknown, fields: readonly string[]): unknown =>
  named(() => {
    if (
      value &&
      typeof value === "object" &&
      "cli" in value &&
      typeof value.cli === "string" &&
      "contract" in value &&
      "commands" in value &&
      Array.isArray(value.commands)
    )
      return { ...value, commands: projectCommands(value.commands as CommandInfo[], fields) }
    return coreProjectFields(value, fields)
  })
