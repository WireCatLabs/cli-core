import { CliError } from "@wirecat/cli-base"
import { hitFiles } from "./attachments.js"
import type { Attachment } from "./models.js"
import { chatReferenceOf } from "./ref-arguments.js"

export type MessagePermalink =
  | { url: string; access: "public" | "restricted" | "unknown"; reason: null }
  | { url: null; access: "unavailable"; reason: "unsupported_chat" | "unsupported_provider" | "offline" }

/**
 * A link to one file of the message, apart from the message's own. No messenger gives one yet: Telegram and
 * WhatsApp have none, and MAX's are short-lived download addresses that hand the bytes to whoever holds them.
 */
export interface FileLink {
  position: number
  kind: string
  name?: string
  url: null
  reason: "unsupported_provider"
}

export type MessageLink = MessagePermalink & { locator: string; files?: FileLink[] }

export const fileLinks = (attachments: readonly Attachment[]): FileLink[] =>
  hitFiles(attachments).map(({ position, kind, name }) => ({
    position,
    kind,
    ...(name === undefined ? {} : { name }),
    url: null,
    reason: "unsupported_provider",
  }))

/** A chat and a message id, or one reference naming both; a reference's account is for the caller to check. */
export const messageLinkTarget = (reference: string, message: string | undefined, provider: string) => {
  const named = chatReferenceOf(reference, provider, "message")
  if (named?.message !== undefined) {
    if (message !== undefined) throw new CliError("validation_error", "a locator already names the message")
    validMessageId(named.message)
    return { chat: named.chat, message: named.message, account: named.account, text: named.text }
  }
  if (message === undefined) throw new CliError("validation_error", "which message? give its id after the chat")
  validMessageId(message)
  if (named) return { chat: named.chat, message, account: named.account, text: named.text }
  if (!reference.trim()) throw new CliError("validation_error", "which chat? give its id or title")
  return { chat: reference, message, account: undefined, text: reference }
}

const validMessageId = (id: string): void => {
  if (
    !id ||
    id.length > 256 ||
    /\s/u.test(id) ||
    [...id].some((part) => {
      const code = part.charCodeAt(0)
      return code < 32 || (code >= 127 && code <= 159)
    })
  )
    throw new CliError(
      "validation_error",
      "a message id must be nonempty, at most 256 characters, without spaces or controls",
    )
}

export const validatePermalink = (link: MessagePermalink): MessagePermalink => {
  if (link.url === null) {
    if (link.access !== "unavailable" || !["unsupported_chat", "unsupported_provider", "offline"].includes(link.reason))
      throw new CliError("validation_error", "the messenger returned invalid permalink metadata")
    return { url: link.url, access: link.access, reason: link.reason }
  }
  let url: URL
  try {
    url = new URL(link.url)
  } catch {
    throw new CliError("validation_error", "the messenger returned an invalid permalink")
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    /\s/u.test(link.url) ||
    link.reason !== null ||
    !["public", "restricted", "unknown"].includes(link.access)
  )
    throw new CliError("validation_error", "the messenger returned an invalid permalink")
  return { url: link.url, access: link.access, reason: link.reason }
}
