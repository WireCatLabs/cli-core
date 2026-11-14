import { CliError, type KeyringStore } from "@wirecat/cli-base"
import type { Settings } from "../cli/settings.js"
import { type Fetch, OPENAI_URL } from "../embeddings/remote.js"
import { aiKeys, aiOrigin, aiSettingPath, readAiSetting } from "../models/ai.js"
import { onThisComputer } from "../models/endpoint.js"
import { localOnly, localOnlyRefusal } from "../models/local-only.js"
import { type AppIdentity, readOnlyLockOf, readOnlyRefusal } from "../ports/app.js"
import { typedCommand } from "../runs/scope.js"
import type { Pcm } from "./decode.js"
import { OPENAI_TRANSCRIBE_MODEL } from "./models.js"
import type { TimedText } from "./recognize.js"

export interface CloudSpeechDeps {
  app: AppIdentity
  env: NodeJS.ProcessEnv
  keyring?: KeyringStore | undefined
  /**
   * The profile's settings. Only the profile's own `transcribeWith: "openai"` turns cloud speech on, never the shared
   * defaults: sending a business's calls away is decided for one profile at a time.
   */
  settings: Pick<Settings, "configured">
  /** Called once, before the first audio leaves the computer, with the line the run shows on stderr. */
  notify: (line: string) => void
  fetch?: Fetch
  signal?: AbortSignal | undefined
  /** The voice detector model that cuts the speech into pieces; the shared models directory's when not given. */
  vadModel?: string
}

export interface CloudSpeech {
  /**
   * One channel's speech as timed pieces. Each stretch of speech is sent alone, at most ten minutes, under the
   * provider's 25 MB per request; `bundle` sends fewer, longer pieces when the turns do not matter.
   */
  recognize(audio: Pcm, options?: { bundle?: boolean }): Promise<TimedText[]>
  /** What a host keeps with the transcript: `openai`, or the host name of a compatible service, and the model. */
  recognition: { engine: string; model: string }
  /** The address the audio goes to, `https://api.openai.com/v1` or the shared AI model's `--base-url`. */
  baseUrl: string
  /** False only for a compatible service on this computer. */
  leavesComputer: boolean
}

/**
 * Where the audio goes: the shared AI model's address when it is OpenAI or compatible (`models ai set openai
 * --base-url …`), else OpenAI's own. The key is the one kept for that address, never another's.
 */
const addressOf = (env: NodeJS.ProcessEnv): string => {
  const setting = readAiSetting(aiSettingPath(env))
  return setting?.provider === "openai" && setting.base_url ? setting.base_url : OPENAI_URL
}

/**
 * Speech to text by an OpenAI-compatible `/audio/transcriptions`, for a host that transcribes recordings (calls,
 * meetings). `null` unless the profile set `transcribeWith` to `openai`: the default is a local model and nothing
 * leaves the computer. Refuses, before any audio is read, in a read-only process, with local only on for an address
 * off this computer, and without a key for the address.
 */
export const cloudSpeech = (deps: CloudSpeechDeps): CloudSpeech | null => {
  if (deps.settings.configured.transcribeWith !== "openai") return null
  const baseUrl = addressOf(deps.env)
  const origin = aiOrigin({ provider: "openai", base_url: baseUrl })
  const host = new URL(origin).host
  const official = origin === "https://api.openai.com"
  const leavesComputer = !onThisComputer(baseUrl)
  const lock = readOnlyLockOf(deps.app, deps.env)
  if (lock && leavesComputer) throw readOnlyRefusal(lock, `send audio to ${host}`)
  if (leavesComputer && localOnly(deps.env)) throw localOnlyRefusal("the recordings", host)
  const apiKey = aiKeys(deps.app, deps.env, deps.keyring).read(origin)?.key
  const setKey = typedCommand(
    deps.app.command,
    official
      ? "models ai set openai --model <model> --secret-stdin"
      : `models ai set openai --base-url ${baseUrl} --secret-stdin`,
  )
  if (!apiKey && leavesComputer)
    throw new CliError(
      "authentication_error",
      `no key for ${host} — \`${setKey}\`${official ? ", or OPENAI_API_KEY" : ""}`,
      {
        reason: "transcription.no-key",
      },
    )
  const configuredModel = deps.settings.configured.transcribeModel
  const model =
    typeof configuredModel === "string" && configuredModel.trim() ? configuredModel.trim() : OPENAI_TRANSCRIBE_MODEL
  let told = false
  return {
    baseUrl,
    leavesComputer,
    recognition: { engine: official ? "openai" : host, model },
    recognize: async (audio, options = {}) => {
      if (!told) {
        told = true
        deps.notify(
          leavesComputer
            ? `the recordings' audio leaves this computer: it goes to ${host} (${model}) to be transcribed`
            : `the recordings' audio goes to ${host} on this computer (${model}) to be transcribed`,
        )
      }
      const { transcribeOpenAI } = await import("./openai.js")
      return transcribeOpenAI(audio, {
        apiKey: apiKey ?? "",
        model,
        baseUrl,
        label: official ? "OpenAI" : host,
        keyHint: setKey,
        env: deps.env,
        ...(options.bundle ? { bundle: true } : {}),
        ...(deps.vadModel ? { vadModel: deps.vadModel } : {}),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
      })
    },
  }
}
