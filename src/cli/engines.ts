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

/** What a command adds to an engine's install: progress for a person at a terminal, and the `fetch` a test hands in. */
export const engineInstall = (command: Command): { fetch?: Fetch; progress?: (line: string) => void } => {
  const { fetch } = environmentOf<BaseEnvironment & { fetch?: Fetch }>(command)
  const progress = engineProgress(command)
  return { ...(fetch ? { fetch } : {}), ...(progress ? { progress } : {}) }
}

/** The engine for a command that needs it, installed on first use without a question; see `ensureEngine`. */
export const engineFor = (command: Command, pin: EnginePin, retry: string): Promise<EngineState> => {
  const { env } = environmentOf(command)
  return ensureEngine(pin, { retry, ...(env ? { env } : {}), ...engineInstall(command) })
}
