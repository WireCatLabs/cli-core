import { CliError } from "@wirecat/cli-base"
import { type QueryAst, type QueryRegistry, queryFieldsOf } from "@wirecat/cli-base/query"
import type * as v from "valibot"
import { formatLocator, isLocator, parseLocator } from "../domain/locator.js"
import type { Id } from "../domain/models.js"
import { formatReference } from "../domain/references.js"
import { normalizeTag, type TagType } from "../domain/tags.js"
import { tagging } from "../entities/tagging.js"
import { pickPerson } from "../resolve.js"
import type { AccountKey, MessageStore, StoredTag, TagTarget, TaskTagTarget } from "../store/store.js"
import { type ColumnMap, queryFilter } from "../store/store.js"
import type { ServiceDeps } from "./deps.js"
import { storedChatId } from "./message-resolution.js"

/** As typed: `chat` alone is the chat; with `message`, a message in it. `message` may be a locator instead. */
export interface TagTargetInput {
  chat?: string
  contact?: string
  message?: string
  /** A task's id or key, as tasks list shows it. */
  task?: string
}

export interface TagTargetView {
  type: TagType
  chatId?: Id
  personId?: Id
  messageId?: Id
  locator?: string
  taskId?: string
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
  list(request: {
    query?: QueryAst
    limit: number
    offset: number
  }): Promise<{ items: TaggingItem[]; has_more: boolean }>
}

export type TaggingItem = v.InferOutput<typeof tagging>

export const TAGGING_QUERY = {
  entity: "tagging",
  backend: "sql",
  fields: queryFieldsOf(tagging, {
    exclude: ["target"],
    examples: { tag: "tag:work", name: "name:*club*" },
  }),
} as const satisfies QueryRegistry

const TAGGING_COLUMNS: ColumnMap = {
  tag: { type: "kw", sql: "x.tag" },
  type: { type: "enum", sql: "x.tag_type" },
  name: { type: "kw", sql: "x.name_folded", folded: true },
  sources: {
    where: (node) =>
      node.operator === "wildcard"
        ? { sql: "1", params: [] }
        : node.value.toLowerCase() === "auto"
          ? { sql: "x.auto = 1", params: [] }
          : { sql: "(x.auto = 0 OR x.source = 'owner')", params: [] },
  },
  created_at: { type: "time", sql: "x.created_at" },
}

const taggingOf = (key: AccountKey, one: StoredTag): TaggingItem => ({
  tag: one.tag,
  type: one.type,
  target:
    one.type === "contact"
      ? formatReference({ type: "contact", provider: key.provider, id: one.personId ?? "" })
      : one.type === "task"
        ? `task:${one.taskId ?? ""}`
        : one.type === "message" && one.locator
          ? one.locator
          : formatReference({ type: "chat", provider: key.provider, account: key.account, chat: one.chatId ?? "" }),
  name: (one.type === "contact" ? one.name : one.chatTitle) ?? null,
  sources: one.sources ?? ["manual"],
  created_at: one.createdAt,
})

const ONE_TARGET =
  "name one thing: --chat <chat>, --contact <person>, --task <task>, or --message <message> with --chat " +
  "(or a msg: locator alone)"

const tagsOf = (given: string[]): string[] => {
  if (given.length === 0) throw new CliError("validation_error", "name at least one tag")
  return [...new Set(given.map(normalizeTag))]
}

const targetOf = async (
  deps: ServiceDeps,
  store: MessageStore,
  account: AccountKey,
  { chat, contact, message, task }: TagTargetInput,
): Promise<TagTarget | TaskTagTarget> => {
  if (task !== undefined) {
    if (chat !== undefined || contact !== undefined || message !== undefined)
      throw new CliError("validation_error", ONE_TARGET)
    return { type: "task", taskId: task.trim().replace(/^task:/, "") }
  }
  if (contact !== undefined) {
    if (chat !== undefined || message !== undefined) throw new CliError("validation_error", ONE_TARGET)
    const person = pickPerson(contact, await store.people.people(account.provider, { account: account.account }))
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
  const chatId = await storedChatId(deps.messenger, chat, store, account, { includeLeft: true })
  return message === undefined ? { type: "chat", chatId } : { type: "message", chatId, messageId: message.trim() }
}

const viewOf = (account: AccountKey, target: TagTarget | TaskTagTarget): TagTargetView =>
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
        const added = await store.tags.addTags(account, target, tags)
        return { target: viewOf(account, target), added, unchanged: tags.filter((tag) => !added.includes(tag)) }
      }),

    remove: (given, list, source) =>
      inStore(async (store, account) => {
        const tags = tagsOf(list)
        const target = await targetOf(deps, store, account, given)
        const removed = await store.tags.removeTags(account, target, tags, source)
        return { target: viewOf(account, target), removed, unchanged: tags.filter((tag) => !removed.includes(tag)) }
      }),

    list: ({ query, limit, offset }) =>
      inStore(async (store, account) => {
        const where = query ? queryFilter(query, TAGGING_COLUMNS, { command: "tags list" }) : undefined
        const rows = await store.tags.tags(account, {
          ...(where ? { where } : {}),
          window: { limit: limit + 1, offset },
        })
        return { items: rows.slice(0, limit).map((one) => taggingOf(account, one)), has_more: rows.length > limit }
      }),
  }
}
