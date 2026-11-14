import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { storePath } from "../store/path.js"
import { readSharedSection, sharedConfigPath, writeSharedSection } from "../store/shared-config.js"

export const CHAT_SENDING_MODES = ["allowed", "ask", "denied"] as const
export type ChatSendingMode = (typeof CHAT_SENDING_MODES)[number]

const SECTION = "chat_sending"

const Setting = v.strictObject({
  mode: v.picklist(CHAT_SENDING_MODES),
  at: v.pipe(v.string(), v.isoTimestamp()),
})

export type ChatSendingSetting = v.InferOutput<typeof Setting>

const pathOf = (env: NodeJS.ProcessEnv) => sharedConfigPath(storePath(env), env)

/** The owner's choice, ask when absent. A broken section reads as denied: a typo must not let chat text out. */
export const readChatSending = (env: NodeJS.ProcessEnv): ChatSendingSetting | undefined => {
  const section = readSharedSection(pathOf(env), SECTION)
  if (section === undefined || section === null) return undefined
  const checked = v.safeParse(Setting, section)
  return checked.success ? checked.output : { mode: "denied", at: new Date(0).toISOString() }
}

export const chatSendingMode = (env: NodeJS.ProcessEnv): ChatSendingMode => readChatSending(env)?.mode ?? "ask"

export const writeChatSending = (env: NodeJS.ProcessEnv, mode: ChatSendingMode): void =>
  writeSharedSection(pathOf(env), SECTION, mode === "ask" ? undefined : { mode, at: new Date().toISOString() })

const STRICTNESS: Record<ChatSendingMode, number> = { allowed: 0, ask: 1, denied: 2 }

/** An agent may make the setting stricter, never looser: loosening lets the owner's chats out. */
export const loosens = (from: ChatSendingMode, to: ChatSendingMode): boolean => STRICTNESS[to] < STRICTNESS[from]

export const chatSendingCommand = (command: string, mode: ChatSendingMode): string =>
  `${command} models chats set ${mode}`

/**
 * Throws when the setting is denied; answers whether the run may go ahead without asking. Called only for a model
 * that is not on this computer: a local model is never "outside".
 */
export const chatSendingAllowed = (env: NodeJS.ProcessEnv, host: string, command: string): boolean => {
  const mode = chatSendingMode(env)
  if (mode === "denied")
    throw new CliError(
      "permission_error",
      `sending chat text to a model outside this computer is denied by the setting \`models chats\`; nothing was sent ` +
        `to ${host}, and --yes does not change that. Use a model on this computer, or ask the owner to run ` +
        `\`${chatSendingCommand(command, "ask")}\` (or \`allowed\`)`,
      { reason: "chat-sending.denied" },
    )
  return mode === "allowed"
}

/** The refusal under ask when nobody can answer: what an agent can do next. */
export const chatSendingAskRefusal = (what: string, command: string): CliError =>
  new CliError(
    "confirmation_required",
    `${what} — add --yes to send them (an agent may pass yes), or ask the owner to run ` +
      `\`${chatSendingCommand(command, "allowed")}\` so no yes is needed`,
    { reason: "chat-sending.ask" },
  )
