import { CliError } from "@wirecat/cli-base"
import { formatLocator, isLocator, parseLocator } from "../domain/locator.js"
import type { Id } from "../domain/models.js"
import { normalizeTag, type TagType } from "../domain/tags.js"
import { pickPerson } from "../resolve.js"
import type { AccountKey, MessageStore, StoredTag, TagTarget } from "../store/store.js"
import type { ServiceDeps } from "./deps.js"
import { storedChatId } from "./messages.js"

/** As typed: `chat` alone is the chat; with `message`, a message in it. `message` may be a locator instead. */
export interface TagTargetInput {
  chat?: string
  contact?: string
  message?: string
}

export interface TagTargetView {
  type: TagType
  chatId?: Id
  personId?: Id
  messageId?: Id
  locator?: string
}

export interface TagsAdded {
  target: TagTargetView
  added: string[]
  /** Given, and already on it. */
  unchanged: string[]
}

export interface TagsRemoved {
  target: TagTargetView
  removed: string[]
  /** Given, and not on it. */
  unchanged: string[]
}

/** The owner's labels in the local store; never sent to the messenger. */
export interface TagsService {
  add(target: TagTargetInput, tags: string[]): Promise<TagsAdded>
  remove(target: TagTargetInput, tags: string[], source?: "manual" | "auto"): Promise<TagsRemoved>
  list(filter?: { tag?: string; type?: TagType; source?: "manual" | "auto" }): Promise<StoredTag[]>
}

const ONE_TARGET =
  "name one thing: --chat <chat>, --contact <person>, or --message <message> with --chat (or a msg: locator alone)"

const tagsOf = (given: string[]): string[] => {
  if (given.length === 0) throw new CliError("validation_error", "name at least one tag")
  return [...new Set(given.map(normalizeTag))]
}

const targetOf = async (
  deps: ServiceDeps,
  store: MessageStore,
  account: AccountKey,
  { chat, contact, message }: TagTargetInput,
): Promise<TagTarget> => {
  if (contact !== undefined) {
    if (chat !== undefined || message !== undefined) throw new CliError("validation_error", ONE_TARGET)
    const person = pickPerson(contact, await store.people(account.provider, { account: account.account }))
    return { type: "contact", personId: person.id }
  }
  if (message !== undefined && isLocator(message)) {
    if (chat !== undefined) throw new CliError("validation_error", "a locator already names the chat — drop --chat")
    const locator = parseLocator(message)
    if (locator.provider !== account.provider || locator.account !== account.account)
      throw new CliError("validation_error", "that locator belongs to another account; select its profile first")
    return { type: "message", chatId: locator.chat, messageId: locator.message }
  }
  if (chat === undefined) throw new CliError("validation_error", ONE_TARGET)
  const chatId = await storedChatId(deps.messenger, chat, store, account)
  return message === undefined ? { type: "chat", chatId } : { type: "message", chatId, messageId: message.trim() }
}

const viewOf = (account: AccountKey, target: TagTarget): TagTargetView =>
  target.type === "message"
    ? { ...target, locator: formatLocator({ ...account, chat: target.chatId, message: target.messageId }) }
    : target

export const tagsService = (deps: ServiceDeps): TagsService => {
  const inStore = async <T>(work: (store: MessageStore, account: AccountKey) => Promise<T>): Promise<T> =>
    work(await deps.store(), await deps.account())

  return {
    add: (given, list) =>
      inStore(async (store, account) => {
        const tags = tagsOf(list)
        const target = await targetOf(deps, store, account, given)
        const added = await store.addTags(account, target, tags)
        return { target: viewOf(account, target), added, unchanged: tags.filter((tag) => !added.includes(tag)) }
      }),

    remove: (given, list, source) =>
      inStore(async (store, account) => {
        const tags = tagsOf(list)
        const target = await targetOf(deps, store, account, given)
        const removed = await store.removeTags(account, target, tags, source)
        return { target: viewOf(account, target), removed, unchanged: tags.filter((tag) => !removed.includes(tag)) }
      }),

    list: (filter = {}) =>
      inStore((store, account) =>
        store.tags(account, {
          ...(filter.source === undefined ? {} : { source: filter.source }),
          ...(filter.tag === undefined ? {} : { tag: normalizeTag(filter.tag) }),
          ...(filter.type === undefined ? {} : { type: filter.type }),
        }),
      ),
  }
}
