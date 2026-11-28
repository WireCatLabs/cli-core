import type { Command } from "commander"
import { type EnginePin, type EngineState, ensureEngine } from "../engines/install.js"
import type { Fetch } from "../speech/install.js"
import { type BaseEnvironment, environmentOf, outputFor } from "./context.js"

/**
 * Where an install's progress goes: stderr, and only for a person reading the pretty view. A `--json` run, an MCP
 * call or `--quiet` gets nothing extra, so its output stays exactly what it would be with the engine installed.
 */
export const engineProgress = (command: Command): ((line: string) => void) | undefined => {
  if (environmentOf(command).agent) return undefined
  const output = outputFor(command)
  return output.format === "pretty" ? (line) => output.renderer.note(line) : undefined
}

/** The engine for a command that needs it, installed on first use without a question; see `ensureEngine`. */
export const engineFor = (command: Command, pin: EnginePin, retry: string): Promise<EngineState> => {
  const environment = environmentOf<BaseEnvironment & { fetch?: Fetch }>(command)
  const progress = engineProgress(command)
  return ensureEngine(pin, {
    retry,
    ...(environment.env ? { env: environment.env } : {}),
    ...(environment.fetch ? { fetch: environment.fetch } : {}),
    ...(progress ? { progress } : {}),
  })
}
