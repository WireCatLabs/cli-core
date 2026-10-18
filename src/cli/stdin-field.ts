import type { Command } from "commander"

/** What a command reads on stdin, as the MCP input field that carries it for an agent, which has no stdin to give. */
export interface StdinField {
  name: string
  description: string
  /** The command parses it as JSON, so an agent may give the object itself. */
  json?: true
}

const fields = new WeakMap<Command, StdinField>()

export const readsStdin = <T extends Command>(command: T, field: StdinField): T => {
  fields.set(command, field)
  return command
}

export const stdinFieldOf = (command: Command): StdinField | undefined => fields.get(command)
