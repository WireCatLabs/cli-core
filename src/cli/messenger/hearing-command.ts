import type { Message } from "../../domain/models.js"
import { type Hearing, hasAudio, hearVoices, openKept, spoken, withTranscript } from "../../speech/hearing.js"
import { choose } from "../../speech/transcribe.js"
import type { Messenger, MessengerContext, ReadConnection } from "./context.js"

export const TRANSCRIBE_OPTION = [
  "--transcribe",
  "turn voice messages not heard yet into text — by the messenger where it can, else by a model on this machine; can take minutes",
] as const

export const MODEL_OPTION = [
  "--model <model>",
  "which downloaded speech model hears them, with --transcribe; `models list` shows them",
] as const

/**
 * Kept transcripts on every read; new ones with `--transcribe`, using the read's connection when
 * supplied. It is released before local recognition. `undefined` when there is no voice message, and then no file is opened.
 */
export const hearForCommand = async (
  context: MessengerContext,
  messenger: Messenger,
  messages: readonly Message[],
  transcribe: boolean,
  model?: string,
  connect?: ReadConnection,
): Promise<Hearing | undefined> => {
  if (!messages.some(hasAudio)) return undefined
  const offline = context.settings.offline
  if (transcribe && offline) context.renderer.note("--offline: only voice messages heard before show their text")
  const kept = await openKept(messenger, context.profile, context.env)
  try {
    const hearing = await hearVoices(
      messenger,
      messages,
      kept,
      transcribe && !offline
        ? {
            choice: {
              ...choose(messenger, context.settings, model === undefined ? {} : { model }, context.env),
              ...(context.recognizer ? { open: context.recognizer } : {}),
            },
            connect: connect ?? ((work) => context.withMessenger(work)),
          }
        : undefined,
    )
    if (transcribe && hearing.problem) context.renderer.note(`not transcribed: ${hearing.problem}`)
    else if (transcribe && hearing.unheard.length > 0) {
      context.renderer.note(`${hearing.unheard.length} voice message(s) not heard yet — ask again later`)
    }
    return offline ? { ...hearing, offline: `${messenger.app.command} ${context.profile}` } : hearing
  } finally {
    await kept.close()
  }
}

export { heard as heardItems, hearingMissing } from "../../speech/hearing.js"

/** The messages as a person reads them: the transcript under the text. */
export const spokenItems = <T extends Message>(messages: readonly T[], hearing: Hearing | undefined): T[] =>
  hearing ? messages.map((message) => spoken(withTranscript(message, hearing)) as T) : [...messages]

/** What the envelope adds when `--transcribe` was asked for. */
export const hearingFields = (hearing: Hearing | undefined, transcribe: boolean) =>
  transcribe
    ? {
        unheard: hearing?.unheard ?? [],
        ...(hearing?.problem === undefined ? {} : { transcribeProblem: hearing.problem }),
      }
    : {}
