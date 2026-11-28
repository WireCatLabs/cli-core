import { engineMissingError, ensureEngine, SAME_COMMAND_AGAIN } from "../engines/install.js"
import { ENGINE_PINS } from "../engines/pins.js"
import type { Fetch } from "./install.js"

/** How the voice engines install on first use. Every field may be left out by a library caller. */
export interface VoiceEngines {
  /** Whose WireCat data folder holds the engines; this process's when absent. */
  env?: NodeJS.ProcessEnv
  fetch?: Fetch
  /** Lines for a person, given only when they go to stderr. */
  progress?: (line: string) => void
  /** The command that installs the engines, named when they cannot be installed now. */
  retry?: string
}

export type VoiceEngine = "sherpa-onnx" | "ogg-opus-decoder"

/**
 * An install that failed is not tried again with the same options: a list of twenty voice notes would otherwise wait
 * out a stalled download twenty times.
 */
const failed = new WeakMap<VoiceEngines, Map<VoiceEngine, Error>>()

/**
 * The folder the engine loads from, installed there first when it is not, with no question asked. One that cannot be
 * installed now is an `engine.missing` error naming the command that installs it.
 */
export const voiceEngineFolder = async (name: VoiceEngine, engines: VoiceEngines = {}): Promise<string> => {
  const before = failed.get(engines)?.get(name)
  if (before) throw before
  const state = await ensureEngine(ENGINE_PINS[name], {
    retry: engines.retry ?? SAME_COMMAND_AGAIN,
    ...(engines.env ? { env: engines.env } : {}),
    ...(engines.fetch ? { fetch: engines.fetch } : {}),
    ...(engines.progress ? { progress: engines.progress } : {}),
  })
  if (state.status === "ready") return state.folder
  const error = engineMissingError(state)
  failed.set(engines, (failed.get(engines) ?? new Map()).set(name, error))
  throw error
}

/** Both voice engines, for `models download`, which a person runs to make voice work here. */
export const installVoiceEngines = async (engines: VoiceEngines = {}): Promise<void> => {
  await voiceEngineFolder("ogg-opus-decoder", engines)
  await voiceEngineFolder("sherpa-onnx", engines)
}
