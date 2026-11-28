import type { Tokenizer } from "@huggingface/tokenizers"
import { CliError } from "@wirecat/cli-base"
import {
  type EngineMissing,
  type EnginePin,
  engineRequire,
  ensureEngine,
  importFromEngine,
} from "../engines/install.js"
import { ENGINE_PINS } from "../engines/pins.js"
import type { Fetch } from "../speech/install.js"
import type { Ort } from "./onnx-runtime.js"

const ONNX = "@wirecat/cli-core-onnx"
const TOKENIZERS = "@huggingface/tokenizers"

/** The engines search by meaning runs on, installed into the WireCat data folder the first time a model loads. */
export const MEANING_ENGINES: readonly [EnginePin, EnginePin] = [ENGINE_PINS[ONNX], ENGINE_PINS[TOKENIZERS]]

export interface EngineContext {
  env?: NodeJS.ProcessEnv
  /** The command that installs them again with progress, such as `tg models download e5-small`. */
  retry?: string
  progress?: (line: string) => void
  fetch?: Fetch
  /** Already installed by the parent of the process that loads them. */
  folders?: MeaningFolders
}

/** Where each engine's packages resolve from: a child process gets these, not an env to work them out again. */
export interface MeaningFolders {
  onnx: string
  tokenizers: string
}

export interface MeaningEngine {
  readonly ort: Ort
  readonly Tokenizer: typeof Tokenizer
  readonly folders: MeaningFolders
}

/** Both engines, installed when they are not yet: `pins` are cli-core's own but in a test. */
export const installMeaningEngines = async (
  { env, retry = "models download", progress, fetch }: EngineContext,
  pins: readonly [EnginePin, EnginePin] = MEANING_ENGINES,
): Promise<MeaningFolders> => {
  const states = await Promise.all(
    pins.map((pin) =>
      ensureEngine(pin, {
        retry,
        ...(env ? { env } : {}),
        ...(progress ? { progress } : {}),
        ...(fetch ? { fetch } : {}),
      }),
    ),
  )
  const missing = states.find((state): state is EngineMissing => state.status === "engine-missing")
  if (missing) throw engineMissing(missing)
  const [onnx, tokenizers] = states.map((state) => (state.status === "ready" ? state.folder : ""))
  return { onnx: onnx as string, tokenizers: tokenizers as string }
}

/**
 * `not_found`, as a model that is not downloaded is: every search that has a word lane catches that code and answers
 * by words alone, naming why.
 */
export const engineMissing = (state: EngineMissing): CliError =>
  new CliError(
    "not_found",
    `search by meaning needs ${state.engine} ${state.version}, which could not be installed: ${state.reason} — run the command again, or \`${state.retry}\``,
    { reason: "model.engine-missing", engine: state.engine, version: state.version, retry: state.retry },
  )

let locate = (context: EngineContext) => installMeaningEngines(context)

/** cli-core's own tests resolve the engines from its devDependencies; `undefined` puts the installer back. */
export const locateMeaningEngine = (next?: (context: EngineContext) => Promise<MeaningFolders>): void => {
  locate = next ?? ((context) => installMeaningEngines(context))
}

const loaded = new Map<string, Promise<MeaningEngine>>()

/** The engines loaded from `folders`, once per process: a native binding, once loaded, stays. */
export const meaningEngineAt = (folders: MeaningFolders): Promise<MeaningEngine> => {
  const key = `${folders.onnx}\n${folders.tokenizers}`
  let found = loaded.get(key)
  if (!found) {
    found = (async () => ({
      ort: await importFromEngine<Ort>(folders.onnx, ONNX),
      // Its `require` export is CommonJS, which names `Tokenizer` for certain; an `import` of it might not.
      Tokenizer: (engineRequire(folders.tokenizers)(TOKENIZERS) as { Tokenizer: typeof Tokenizer }).Tokenizer,
      folders,
    }))()
    found.catch(() => loaded.delete(key))
    loaded.set(key, found)
  }
  return found
}

/** The engines installed, with no question, when they are not yet, then loaded; a failure is `model.engine-missing`. */
export const meaningEngine = async (context: EngineContext = {}): Promise<MeaningEngine> =>
  meaningEngineAt(context.folders ?? (await locate(context)))

/** The command that downloads `model` again, and with it the engines, in a CLI named `command` or in any. */
export const modelRetry = (model: string, command: string | undefined, words = "models download"): string =>
  command ? `${command} ${words} ${model}` : `${words} ${model} (in tg, max or wa)`
