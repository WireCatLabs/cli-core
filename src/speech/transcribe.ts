import { CliError, isCliError, type KeyringStore } from "@wirecat/cli-base"
import type { Messenger } from "../cli/messenger/context.js"
import { fromFile, type Settings } from "../cli/settings.js"
import { embeddingKeys } from "../embeddings/keys.js"
import { readOnlyLockOf, readOnlyRefusal } from "../ports/app.js"
import { capability, type MessengerAdapter, type RemoteFile, type Transcript } from "../ports/messenger.js"
import { typedCommand } from "../runs/scope.js"
import type { Ffmpeg } from "./decode.js"
import { installedBytes, isInstalled, megabytes, modelPath, modelsDirectory, vadPath } from "./install.js"
import { OPENAI_TRANSCRIBE_MODEL, orderedModels, type SpeechModel, speechModel } from "./models.js"
import type { Recognizer } from "./recognize.js"

/**
 * `messenger`: its own recognition (Telegram Premium). `local`: a model on this machine. `auto`: the first, then the
 * second. `openai`: OpenAI's API, only when asked by name — `auto` never sends audio off the machine.
 */
export const TRANSCRIBE_WITH = ["auto", "messenger", "local", "openai"] as const
export type TranscribeWith = (typeof TRANSCRIBE_WITH)[number]

export interface Heard extends Transcript {
  messageId: string
  /** The messenger's provider, `local` or `openai`. */
  via: string
  /** The local or OpenAI model, when it was one. */
  model?: string
}

/** A recording is read into memory whole; minutes of Opus are a few megabytes. */
const LARGEST_VOICE = 32 * 1024 * 1024

export type OpenRecognizer = (model: SpeechModel, path: (name: string) => string, vadModel: string) => Recognizer

export interface Choice {
  with: TranscribeWith
  model: SpeechModel
  /** Where the models are, `modelsDirectory` for the command's environment. */
  directory: string
  /** The local recognizer, where a test hands one in. */
  open?: OpenRecognizer
  ffmpeg?: Ffmpeg
  /** The profile's `transcribeModel` for `openai`, else `gpt-transcribe`. */
  transcribeModel?: string
  apiKey?: string
  /** Why `openai` cannot run here: no key, or a read-only process. Thrown before anything is fetched. */
  refusal?: CliError
  fetch?: (url: string, init: RequestInit) => Promise<Response>
}

/** A voice note, or an audio file someone sent — an iPhone recording reaches WhatsApp as `audio/mp4`. */
export const isAudioFile = ({ kind, mime }: { kind: string; mime?: string | undefined }): boolean =>
  kind === "voice" || kind === "audio" || (mime?.startsWith("audio/") ?? false)

/** The flag, then the profile's `transcribeWith`, `speechModel` and `transcribeModel`, then `auto` and the CLI's first model. */
export const choose = (
  messenger: Messenger,
  settings: Pick<Settings, "configured" | "shared">,
  flags: { local?: boolean; model?: string; with?: TranscribeWith },
  env: NodeJS.ProcessEnv = process.env,
  keyring?: KeyringStore,
): Choice => {
  const model = flags.model ?? fromFile<string | undefined>(settings, "speechModel", undefined).value
  const chosen =
    flags.local || flags.model !== undefined
      ? "local"
      : (flags.with ?? fromFile<TranscribeWith>(settings, "transcribeWith", "auto").value)
  if (!TRANSCRIBE_WITH.includes(chosen))
    throw new CliError("validation_error", `transcribeWith is one of ${TRANSCRIBE_WITH.join(", ")}`)
  return {
    directory: modelsDirectory(env),
    with: chosen,
    model: model === undefined ? (orderedModels(messenger.speechModels)[0] as SpeechModel) : speechModel(model),
    transcribeModel: fromFile<string>(settings, "transcribeModel", OPENAI_TRANSCRIBE_MODEL).value,
    ...(chosen === "openai" ? openaiAccess(messenger, env, keyring) : {}),
  }
}

const openaiAccess = (
  messenger: Messenger,
  env: NodeJS.ProcessEnv,
  keyring?: KeyringStore,
): Pick<Choice, "apiKey" | "refusal"> => {
  const lock = readOnlyLockOf(messenger.app, env)
  if (lock) return { refusal: readOnlyRefusal(lock, "send audio to OpenAI") }
  const apiKey = embeddingKeys(messenger.app, env, keyring).read("openai")?.key
  return apiKey
    ? { apiKey }
    : {
        refusal: new CliError(
          "authentication_error",
          `no OpenAI key — \`${typedCommand(messenger.app.command, "models keys set openai")}\`, or OPENAI_API_KEY`,
          { reason: "transcription.no-key" },
        ),
      }
}

/** Never a download: a model is hundreds of MB, and whether to fetch one is the owner's call. */
export const notDownloaded = (messenger: Messenger, model: SpeechModel): CliError =>
  new CliError(
    "not_found",
    `the speech model ${model.id} is not on this machine — the owner downloads it once with ` +
      `\`${typedCommand(messenger.app.command, `models download ${model.id}`)}\` (${megabytes(installedBytes(model))})`,
    { reason: "model.not-downloaded", model: model.id },
  )

/**
 * Over an open connection: the messenger's own transcript, or the recording's bytes for a local model.
 * The model runs after the connection closes — a minute of speech should not hold a socket open.
 * `read` gets the recording once its bytes are all in, for a reference the messenger renewed while they were read.
 */
export const hearOnline = async (
  messenger: Messenger,
  connection: MessengerAdapter,
  chat: string,
  messageId: string,
  choice: Choice,
  read?: (file: RemoteFile) => Promise<void>,
): Promise<Heard | Uint8Array> => {
  if (choice.refusal) throw choice.refusal
  if (choice.with === "auto" || choice.with === "messenger") {
    const canAsk = typeof connection.transcribe === "function"
    if (choice.with === "messenger" || canAsk) {
      try {
        const heard = await capability(connection, "transcribe", "transcribe voice messages")(chat, messageId)
        return { messageId, ...heard, via: messenger.provider }
      } catch (error) {
        // `auto` falls back only when the messenger refuses this account; any other failure is real.
        if (choice.with === "messenger" || !(isCliError(error) && error.code === "permission_error")) throw error
      }
    }
  }
  if (choice.with !== "openai" && !isInstalled(choice.model, choice.directory))
    throw notDownloaded(messenger, choice.model)
  const { files } = await capability(connection, "download", "download attachments")(chat, messageId)
  const voice = files.find(isAudioFile)
  if (!voice) throw new CliError("validation_error", "that message has no voice message or audio file")
  const bytes = await readAll(voice)
  await read?.(voice)
  return bytes
}

/** The local model, or OpenAI when chosen, on the bytes `hearOnline` fetched. */
export const hearLocally = async (bytes: Uint8Array, messageId: string, choice: Choice): Promise<Heard> => {
  const { model, directory, open, ffmpeg } = choice
  const { decodeAudio } = await import("./decode.js")
  const { samples, rate } = await decodeAudio(bytes, ffmpeg)
  if (choice.with === "openai") {
    if (choice.refusal) throw choice.refusal
    const { transcribeOpenAI } = await import("./openai.js")
    const transcribeModel = choice.transcribeModel ?? OPENAI_TRANSCRIBE_MODEL
    const pieces = await transcribeOpenAI(
      { samples, rate },
      {
        apiKey: choice.apiKey ?? "",
        model: transcribeModel,
        vadModel: vadPath(directory),
        ...(choice.fetch ? { fetch: choice.fetch } : {}),
      },
    )
    return {
      messageId,
      text: pieces.map(({ text }) => text).join(" "),
      pending: false,
      via: "openai",
      model: transcribeModel,
    }
  }
  const { openRecognizer, toModelRate } = await import("./recognize.js")
  const recognizer = (open ?? openRecognizer)(model, modelPath(directory, model), vadPath(directory))
  try {
    return {
      messageId,
      text: recognizer.recognize(toModelRate(samples, rate)),
      pending: false,
      via: "local",
      model: model.id,
    }
  } finally {
    recognizer.free()
  }
}

/** Where a kept transcript came from, as `Kept` stores it: the messenger's provider, a local model, or `openai:<model>`. */
export const keptSource = (heard: Heard): string =>
  heard.via === "openai" ? `openai:${heard.model ?? OPENAI_TRANSCRIBE_MODEL}` : (heard.model ?? heard.via)

/** The reverse of `keptSource`. */
export const heardVia = (source: string, provider: string): Pick<Heard, "via" | "model"> =>
  source === provider
    ? { via: source }
    : source.startsWith("openai:")
      ? { via: "openai", model: source.slice("openai:".length) }
      : { via: "local", model: source }

const readAll = async (file: RemoteFile): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of file.bytes()) {
    total += chunk.length
    if (total > LARGEST_VOICE) throw new CliError("validation_error", "the voice message is larger than 32 MB")
    chunks.push(chunk)
  }
  return new Uint8Array(Buffer.concat(chunks))
}
