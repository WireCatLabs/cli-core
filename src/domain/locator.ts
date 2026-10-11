import { CliError, singleLine } from "@wirecat/cli-base"
import type { Id, Provider } from "./models.js"

/**
 * Where one message lives, whichever messenger it came from. A message id alone means nothing:
 * Telegram numbers messages per chat in channels and per account in private chats, so only all four
 * parts name exactly one message across every provider and account in a shared store.
 */
export interface MessageLocator {
  provider: Provider
  account: Id
  chat: Id
  message: Id
}

const SCHEME = "msg:"

/** `msg:telegram/12345/-1001234567890/42` — each part percent-encoded, so no id can add a part. */
export const formatLocator = ({ provider, account, chat, message }: MessageLocator): string =>
  SCHEME + [provider, account, chat, message].map(encodeURIComponent).join("/")

export const isLocator = (reference: string): boolean => reference.trim().startsWith(SCHEME)

export const parseLocator = (reference: string): MessageLocator => {
  const trimmed = reference.trim()
  const parts = trimmed.startsWith(SCHEME) ? trimmed.slice(SCHEME.length).split("/") : []
  if (parts.length !== 4 || parts.some((part) => part === "")) {
    throw new CliError(
      "validation_error",
      `"${singleLine(reference)}" is not a message locator — expected msg:<provider>/<account>/<chat>/<message>`,
    )
  }
  const [provider, account, chat, message] = parts.map(decodeURIComponent) as [string, string, string, string]
  return { provider, account, chat, message }
}
