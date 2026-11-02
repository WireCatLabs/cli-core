import { CliError } from "@wirecat/cli-base"
import type { Id, Provider } from "./models.js"
import { providerLabel, providerNamed } from "./providers.js"
import { looksLikeReference, parseReference, type Reference } from "./references.js"

/** A `chat:` or `msg:` reference given where a messenger command takes a chat or a message. */
export interface ChatReference {
  text: string
  provider: Provider
  account: Id
  chat: Id
  message?: Id
}

/** The account a reference must belong to; `account` is `undefined` while this profile's is not known yet. */
export interface RefScope {
  account: Id | undefined
  profile?: string
}

/** The profiles of this app the store saw on an account; `undefined` when that cannot be told. */
export type ProfilesOn = (account: Id) => Promise<readonly string[] | undefined>

type Takes = "chat" | "message"

const TAKES: Record<Takes, string> = {
  chat: "a chat: chat:<provider>/<account>/<chat>, its id or its title",
  message: "a message: msg:<provider>/<account>/<chat>/<message>, or a chat and the message's id",
}

const OPENS: Partial<Record<Reference["type"], string>> = {
  chat: "messages list",
  message: "messages show",
  contact: "contacts show",
}

const article = (word: string) => (/^[aeiou]/.test(word) ? "an" : "a")

const wrongKind = (text: string, kind: Reference["type"], takes: Takes) =>
  new CliError("validation_error", `${text} names ${article(kind)} ${kind}; this takes ${TAKES[takes]}`, {
    reason: "ref.wrong-kind",
  })

const wrongProvider = (text: string, provider: Provider, kind: Reference["type"]) => {
  const command = providerNamed(provider)?.command
  const opens = OPENS[kind]
  const how = command && opens ? `open it with ${command} <profile> ${opens} ${text}` : "open it with its own CLI"
  const label = providerLabel(provider)
  return new CliError("validation_error", `${text} is ${article(label.toLowerCase())} ${label} ${kind}; ${how}`, {
    reason: "ref.wrong-provider",
  })
}

/**
 * The chat or message a reference names, when `text` is one of this provider's; `undefined` for text that is no
 * reference, which stays an id or a title. Another kind or another messenger is refused, never read as a title.
 */
export const chatReferenceOf = (text: string, provider: Provider, takes: "chat" | "message" = "chat") => {
  const trimmed = text.trim()
  if (!looksLikeReference(trimmed)) return undefined
  const reference = parseReference(trimmed)
  if (reference.type !== "chat" && reference.type !== "message") throw wrongKind(trimmed, reference.type, takes)
  if (reference.provider !== provider) throw wrongProvider(trimmed, reference.provider, reference.type)
  const found: ChatReference = {
    text: trimmed,
    provider: reference.provider,
    account: reference.account,
    chat: reference.chat,
    ...(reference.type === "message" ? { message: reference.message } : {}),
  }
  return found
}

/**
 * The identity a `contact:` reference names, when it is one of this provider's; `undefined` for any other text. A
 * `person:` reference is the store's person, which the callers that take one read before this.
 */
export const contactReferenceOf = (text: string, provider: Provider | undefined): Id | undefined => {
  const trimmed = text.trim()
  if (!trimmed.startsWith("contact:")) return undefined
  const reference = parseReference(trimmed)
  if (reference.type !== "contact") return undefined
  if (provider !== undefined && reference.provider !== provider)
    throw wrongProvider(trimmed, reference.provider, reference.type)
  return reference.id
}

/** The refusal of another account's reference: switching to it silently would read or send as somebody else. */
export const wrongAccount = (
  reference: Pick<ChatReference, "text" | "account">,
  scope: RefScope,
  profiles?: readonly string[],
): CliError => {
  const here =
    scope.account === undefined
      ? "the account of this profile is not known yet"
      : `${scope.profile === undefined ? "this profile" : `profile ${scope.profile}`} is account ${scope.account}`
  const others =
    profiles === undefined
      ? ""
      : `. Profiles signed in to ${reference.account}: ${profiles.length > 0 ? profiles.join(", ") : "none here"}`
  return new CliError(
    "validation_error",
    `${reference.text} belongs to account ${reference.account}; ${here}${others}`,
    { reason: "ref.wrong-account" },
  )
}

/** Refuses a reference of another account than the scope's, naming the profiles that have it. */
export const ensureAccount = async (
  reference: Pick<ChatReference, "text" | "account">,
  scope: RefScope,
  profilesOn?: ProfilesOn,
): Promise<void> => {
  if (scope.account !== undefined && scope.account === reference.account) return
  const profiles = await profilesOn?.(reference.account).catch(() => undefined)
  throw wrongAccount(reference, scope, profiles)
}
