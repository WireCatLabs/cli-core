import { CliError, isCliError } from "@wirecat/cli-base"
import type { Messenger } from "../cli/messenger/context.js"
import { fromFile, type Settings } from "../cli/settings.js"
import { capability, type MessengerAdapter, type RemoteFile, type Transcript } from "../ports/messenger.js"
import { typedCommand } from "../runs/scope.js"
import type { Ffmpeg } from "./decode.js"
import { installedBytes, isInstalled, megabytes, modelPath, modelsDirectory, vadPath } from "./install.js"
import { orderedModels, type SpeechModel, speechModel } from "./models.js"
import type { Recognizer } from "./recognize.js"

/** `messenger`: its own recognition (Telegram Premium). `local`: a model on this machine. `auto`: the first, then the second. */
export const TRANSCRIBE_WITH = ["auto", "messenger", "local"] as const
export type TranscribeWith = (typeof TRANSCRIBE_WITH)[number]

export interface Heard extends Transcript {
  messageId: string
  /** The messenger's provider, or `local`. */
  via: string
  /** The local model, when it was one. */
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
}

/** A voice note, or an audio file someone sent — an iPhone recording reaches WhatsApp as `audio/mp4`. */
export const isAudioFile = ({ kind, mime }: { kind: string; mime?: string | undefined }): boolean =>
  kind === "voice" || kind === "audio" || (mime?.startsWith("audio/") ?? false)

/** The flag, then the profile's `transcribeWith` and `speechModel`, then `auto` and the CLI's first model. */
export const choose = (
  messenger: Messenger,
  settings: Pick<Settings, "configured" | "shared">,
  flags: { local?: boolean; model?: string },
  env: NodeJS.ProcessEnv = process.env,
): Choice => {
  const model = flags.model ?? fromFile<string | undefined>(settings, "speechModel", undefined).value
  return {
    directory: modelsDirectory(env),
    with:
      flags.local || flags.model !== undefined
        ? "local"
        : fromFile<TranscribeWith>(settings, "transcribeWith", "auto").value,
    model: model === undefined ? (orderedModels(messenger.speechModels)[0] as SpeechModel) : speechModel(model),
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
  if (choice.with !== "local") {
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
  if (!isInstalled(choice.model, choice.directory)) throw notDownloaded(messenger, choice.model)
  const { files } = await capability(connection, "download", "download attachments")(chat, messageId)
  const voice = files.find(isAudioFile)
  if (!voice) throw new CliError("validation_error", "that message has no voice message or audio file")
  const bytes = await readAll(voice)
  await read?.(voice)
  return bytes
}

/** The local model, on the bytes `hearOnline` fetched. */
export const hearLocally = async (
  bytes: Uint8Array,
  messageId: string,
  { model, directory, open, ffmpeg }: Choice,
): Promise<Heard> => {
  const { openRecognizer, toModelRate } = await import("./recognize.js")
  const { decodeAudio } = await import("./decode.js")
  const { samples, rate } = await decodeAudio(bytes, ffmpeg)
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
