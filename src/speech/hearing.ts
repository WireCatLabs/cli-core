import { CliError } from "@wirecat/cli-base"
import type { Missing } from "@wirecat/cli-base/standards"
import { recalledAccount } from "../cli/messenger/accounts.js"
import type { Messenger } from "../cli/messenger/context.js"
import type { Settings } from "../cli/settings.js"
import type { Message } from "../domain/models.js"
import type { MessengerAdapter } from "../ports/messenger.js"
import { openStore } from "../store/store.js"
import { type Choice, choose, hearLocally, hearOnline } from "./transcribe.js"

/** `--model` chooses who hears what `--transcribe` asks for; alone it would quietly do nothing. */
export const modelWith = (transcribe: boolean | undefined, model: string | undefined): string | undefined => {
  if (model !== undefined && transcribe !== true) {
    throw new CliError("validation_error", "--model picks who hears voice messages with --transcribe; add --transcribe")
  }
  return model
}

/** Telegram polls each voice message for up to a minute; a whole list gets this long, then says what is left. */
export const HEARING_BUDGET_MS = 120_000

export interface Voice {
  chatId: string
  messageId: string
}

export interface Hearing {
  /** By `keyOf`: the text of every voice message heard now or kept from before. */
  transcripts: Map<string, string>
  /** Voice messages still without text after `--transcribe`: out of time, pending, or refused. */
  unheard: Voice[]
  /** Why some were not heard — the first reason; the messages are still worth showing. */
  problem?: string
  /** Set under `--offline`: the command (`<app> <profile>`) that hears a message online, which `--offline` never does. */
  offline?: string
}

export const keyOf = ({ chatId, messageId }: Voice): string => `${chatId}/${messageId}`

/** Telegram says `voice`; MAX says `audio` with Ogg in it. */
export const isVoice = (message: Message): boolean =>
  message.attachments.some(({ kind, mime }) => kind === "voice" || mime === "audio/ogg")

export interface Kept {
  get(voice: Voice): Promise<{ text: string; source: string } | undefined>
  keep(voice: Voice, text: string, source: string): Promise<void>
  close(): Promise<void>
}

/**
 * Transcripts already heard, in the shared store, for the account this profile last logged in as
 * (owner, NEED-418 B). A profile that has never been online has no account yet: nothing is kept for
 * it, and a voice message is heard again next time.
 */
export const openKept = async (messenger: Messenger, profile: string, env: NodeJS.ProcessEnv): Promise<Kept> => {
  const account = recalledAccount(messenger.app, messenger.provider, profile, env)
  if (!account) return { get: async () => undefined, keep: async () => {}, close: async () => {} }
  const store = await openStore({ env })
  return {
    get: ({ chatId, messageId }) => store.messages.transcript(account, chatId, messageId),
    keep: ({ chatId, messageId }, text, source) =>
      store.messages.keepTranscript(account, chatId, messageId, text, source),
    close: () => store.close(),
  }
}

/**
 * Kept transcripts always — they cost nothing; new ones only when `connect` is given (`--transcribe`).
 * The messenger is asked inside one connection; a local model runs after it closes, on the bytes
 * fetched in it. What could not be heard is in `unheard`, never a failure.
 */
export const hearVoices = async (
  messenger: Messenger,
  messages: readonly Message[],
  kept: Kept,
  transcribe?: {
    choice: Choice
    connect: <T>(work: (adapter: MessengerAdapter) => Promise<T>) => Promise<T>
    budgetMs?: number
  },
): Promise<Hearing> => {
  const transcripts = new Map<string, string>()
  const missing: Voice[] = []
  for (const message of messages.filter(isVoice)) {
    const voice = { chatId: message.chatId, messageId: message.id }
    const text = (await kept.get(voice))?.text
    if (text === undefined) missing.push(voice)
    else transcripts.set(keyOf(voice), text)
  }
  if (!transcribe || missing.length === 0) return { transcripts, unheard: missing }

  const { choice, connect, budgetMs = HEARING_BUDGET_MS } = transcribe
  const deadline = Date.now() + budgetMs
  let problem: string | undefined
  const fetched = await connect(async (adapter) => {
    const answers: [Voice, Awaited<ReturnType<typeof hearOnline>>][] = []
    for (const voice of missing) {
      if (Date.now() >= deadline) break
      try {
        answers.push([voice, await hearOnline(messenger, adapter, voice.chatId, voice.messageId, choice)])
      } catch (error) {
        problem ??= error instanceof Error ? error.message : String(error)
      }
    }
    return answers
  })
  for (const [voice, answer] of fetched) {
    try {
      const heard = answer instanceof Uint8Array ? await hearLocally(answer, voice.messageId, choice) : answer
      if (heard.pending || heard.text.trim() === "") continue
      transcripts.set(keyOf(voice), heard.text)
      await kept.keep(voice, heard.text, heard.model ?? heard.via)
    } catch (error) {
      problem ??= error instanceof Error ? error.message : String(error)
    }
  }
  const unheard = missing.filter((voice) => !transcripts.has(keyOf(voice)))
  return { transcripts, unheard, ...(problem === undefined ? {} : { problem }) }
}

/** A message with its transcript, when there is one; others pass through unchanged. */
export const withTranscript = <T extends Message>(message: T, hearing: Hearing): T & { transcript?: string } => {
  const transcript = hearing.transcripts.get(keyOf({ chatId: message.chatId, messageId: message.id }))
  return transcript === undefined ? message : { ...message, transcript }
}

/** How a person sees one: the text the messenger has, then what was heard. */
export const spoken = <T extends Message & { transcript?: string }>({ transcript, ...message }: T): Message =>
  transcript === undefined
    ? message
    : { ...message, text: [message.text, `🎤 ${transcript}`].filter(Boolean).join("\n") }

/** For an MCP tool: the same hearing, over the session's own connection. */
export const hearForTool = async (
  messenger: Messenger,
  connect: <T>(work: (adapter: MessengerAdapter) => Promise<T>) => Promise<T>,
  messages: readonly Message[],
  transcribe: boolean,
  { settings, env }: { settings: Pick<Settings, "configured" | "shared" | "profile">; env: NodeJS.ProcessEnv },
  model?: string,
): Promise<Hearing | undefined> => {
  if (!messages.some(isVoice)) return undefined
  const kept = await openKept(messenger, settings.profile, env)
  try {
    return await hearVoices(
      messenger,
      messages,
      kept,
      transcribe
        ? {
            choice: choose(messenger, settings, model === undefined ? {} : { model }, env),
            connect,
          }
        : undefined,
    )
  } finally {
    await kept.close()
  }
}

/** Messages with their transcripts; `unheard` as well when `--transcribe` was asked for. */
export const heard = <T extends Message>(messages: readonly T[], hearing: Hearing | undefined): T[] =>
  hearing ? messages.map((message) => withTranscript(message, hearing)) : [...messages]

/**
 * Voice messages still without text: why, and the command that hears one. Said without `--transcribe` too, or an
 * answer whose only content is a voice message reads as complete.
 */
export const hearingMissing = (hearing: Hearing | undefined, transcribe: boolean): Missing[] => {
  if (!hearing) return []
  if (transcribe && hearing.problem !== undefined)
    return [{ field: "transcript", why: `not transcribed: ${hearing.problem}`, step: "messages.transcribe" }]
  if (hearing.unheard.length === 0) return []
  if (hearing.offline !== undefined) {
    const commands = hearing.unheard.map(
      ({ chatId, messageId }) => `${hearing.offline} messages transcribe ${chatId} ${messageId}`,
    )
    return [
      {
        field: "transcript",
        why: `--offline reads only transcripts already stored; ${hearing.unheard.length} voice message(s) have none: ${commands.join("; ")}`,
        step: "messages.transcribe",
      },
    ]
  }
  const ids = hearing.unheard.map((voice) => voice.messageId).join(", ")
  return [
    {
      field: "transcript",
      why: transcribe
        ? `${hearing.unheard.length} voice message(s) not heard yet: ${ids}`
        : `${hearing.unheard.length} voice message(s) not heard: ${ids} — --transcribe hears them`,
      step: "messages.transcribe",
    },
  ]
}
