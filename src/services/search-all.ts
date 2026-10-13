import { CliError } from "@wirecat/cli-base"
import type { Messenger } from "../cli/messenger/context.js"
import { parseLocator } from "../domain/locator.js"
import type { MailFields } from "../domain/models.js"
import { INTERNAL_NOTES, kindOf } from "../domain/providers.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { excerpt } from "./excerpt.js"
import { MAX_SEARCH_OFFSET, type SearchFound, type SearchQuery, searchStore } from "./messages.js"
import { RRF_K, searchNotes } from "./notes-search.js"
import type { Backend, ServerOptions, ServerSearched } from "./server-search.js"

export const RESOURCES_SEARCHED = ["messages", "mail", "notes"] as const
export type SearchedResource = (typeof RESOURCES_SEARCHED)[number]

export interface SearchAllItem {
  kind: "message" | "mail" | "note"
  /** `msg:…` for a message or a mail, `note:…` for a note. */
  ref: string
  provider: string
  /** The account it was found in; a note's folder id, or `internal` for a note written in memo. */
  account: string
  /** The chat, the mail thread's subject or the note's title. */
  title: string | null
  timestamp: string
  /** An excerpt around the match: a note's matching line, about 240 characters of a message or mail. */
  text: string
  /** Who wrote it; `ref` is the `person:` reference where the store has one. A note has none. */
  from?: { name: string | null; ref: string | null }
  /** A mail's people, labels and thread, as `search mail` gives them. */
  email?: MailFields
  /** Which search found it: words, meaning or both. */
  foundBy: ("words" | "meaning")[]
}

/** One account a search read, by the kind it was read for: the shape memo's `search all` answers too. */
export interface SearchedAccount {
  resource: string
  provider: string
  account: string
}

/** A resource not read, or a `--source` entry naming no account the search reads. */
export type Skipped<R extends string> =
  | { resource: R; reason: string; source?: undefined }
  | { source: string; reason: string; resource?: undefined }

export interface SearchAllFound {
  query: string
  items: SearchAllItem[]
  hasMore: boolean
  /** Where the next page starts, as `offset`; absent on the last page. */
  nextOffset?: number
  searched: SearchedResource[]
  /** Every account read, kind by kind. */
  accounts: SearchedAccount[]
  /** A resource the query could not be asked of, and why: a field it lacks, or nothing stored yet. */
  skipped: Skipped<SearchedResource>[]
  /** How the notes were searched, when they were. */
  notes?: { by: "words" | "words and meaning"; meaningSkipped?: string }
  /** The messenger's server step for messages, as `search messages` reports it. */
  server?: ServerSearched
}

export interface SearchAllRequest {
  text: string
  limit: number
  /** Skip this many of the merged hits: the `nextOffset` of the page before. */
  offset?: number
  only?: readonly SearchedResource[]
  exact?: boolean
  timezone?: string
  /** For messages only; mail and notes are always the local store's. */
  backend?: Backend
  server?: ServerOptions
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** The accounts `--source` chose, per kind; a kind left out reads every account of its own. */
  scope?: Partial<Record<SearchedResource, AccountKey[]>>
}

/** A query a resource cannot answer is skipped with its reason, never a failure of the whole search. */
const skippable = (error: unknown): error is CliError =>
  error instanceof CliError && (error.code === "validation_error" || error.code === "not_found")

/**
 * `search all`: messages, mail and notes from the local store — messages also from the messenger's
 * server, as `search messages` asks it — each list best first, merged by reciprocal rank so no
 * resource's own scores have to be compared with another's.
 */
export const searchAll = async (
  store: MessageStore,
  account: AccountKey,
  request: SearchAllRequest,
  messenger: Partial<Pick<Messenger, "savedChatId" | "app">> = {},
  searchMessages: (query: SearchQuery) => Promise<SearchFound> = (query) =>
    searchStore(store, account, query, messenger),
): Promise<SearchAllFound> => {
  if (!request.text.trim()) throw new CliError("validation_error", "say what to find")
  const offset = request.offset ?? 0
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_SEARCH_OFFSET)
    throw new CliError("validation_error", `offset takes a whole number from 0 to ${MAX_SEARCH_OFFSET}`)
  // Each resource is read deep enough for the merged page, then the merge is cut.
  const window = offset + request.limit
  const only = request.only ?? RESOURCES_SEARCHED
  const command = messenger.app?.command ?? "tg"
  const lists: SearchAllItem[][] = []
  const searched: SearchedResource[] = []
  const accounts: SearchedAccount[] = []
  const skipped: SearchAllFound["skipped"] = []
  let hasMore = false
  let notes: SearchAllFound["notes"]
  let server: ServerSearched | undefined

  const messagesOf = async (kind: "messages" | "mail") => {
    const given = request.scope?.[kind]
    const query: SearchQuery = {
      text: request.text,
      language: "lucene",
      kind,
      ...(given ? { accounts: given } : {}),
      ...(kind === "messages"
        ? {
            // Server hits are matched by chat and message id, which another account can share.
            ...(request.backend === "server" || given ? {} : { source: "all" }),
            ...(request.backend === undefined ? {} : { backend: request.backend }),
            ...(request.server === undefined ? {} : { server: request.server }),
          }
        : {}),
      limit: window,
      ...(request.exact ? { exact: true } : {}),
      ...(request.timezone === undefined ? {} : { timezone: request.timezone }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }
    // Messages go the way `search messages` goes, server included, so `search all` finds whatever it finds.
    const found =
      kind === "messages" ? await searchMessages(query) : await searchStore(store, account, query, messenger)
    if (found.server) server = found.server
    hasMore ||= found.hasMore
    const read =
      found.coverage?.accounts ?? given ?? (await store.accounts()).filter(({ provider }) => kindOf(provider) === kind)
    accounts.push(...read.map(({ provider, account }) => ({ resource: kind, provider, account })))
    return found.items.map((hit): SearchAllItem => {
      const at = parseLocator(hit.locator)
      return {
        kind: kind === "mail" ? "mail" : "message",
        ref: hit.locator,
        provider: at.provider,
        account: at.account,
        title: hit.chatTitle,
        timestamp: hit.timestamp,
        text: hit.excerpt ?? excerpt(hit.text ?? "", request.text),
        from: hit.email?.from
          ? { name: hit.email.from.name ?? hit.email.from.address, ref: hit.email.from.ref }
          : { name: hit.senderName, ref: null },
        ...(hit.email ? { email: hit.email } : {}),
        foundBy: ["words"],
      }
    })
  }

  for (const resource of only) {
    try {
      if (resource === "notes") {
        const folders = (await store.notes.folders()).map(({ id }) => id)
        const chosen = request.scope?.notes?.map(({ account }) => account)
        const internal = chosen === undefined || chosen.includes(INTERNAL_NOTES)
        const folderIds = chosen === undefined ? folders : folders.filter((id) => chosen.includes(id))
        // The store reads memo's notes beside every folder or alone, never beside some folders: two searches then.
        const whole = internal && folderIds.length === folders.length
        const runs = whole
          ? [{}]
          : [...(internal ? [{ source: "internal" as const }] : []), ...(folderIds.length ? [{ folderIds }] : [])]
        for (const run of runs) {
          const found = await searchNotes(store, request.text, {
            limit: window,
            command,
            ...run,
            ...(request.exact ? { exact: true } : {}),
            ...(request.timezone === undefined ? {} : { timezone: request.timezone }),
            ...(request.env === undefined ? {} : { env: request.env }),
          })
          hasMore ||= found.hasMore
          notes ??= {
            by: found.by,
            ...(found.meaningSkipped === undefined ? {} : { meaningSkipped: found.meaningSkipped }),
          }
          lists.push(
            found.hits.map((hit) => ({
              kind: "note",
              ref: hit.ref,
              provider: "notes",
              account: hit.folderId ?? INTERNAL_NOTES,
              title: hit.title,
              timestamp: hit.modifiedAt,
              text: hit.line,
              foundBy: hit.foundBy,
            })),
          )
        }
        accounts.push(
          ...[...(internal ? [INTERNAL_NOTES] : []), ...folderIds].map((account) => ({
            resource,
            provider: "notes",
            account,
          })),
        )
      } else lists.push(await messagesOf(resource))
      searched.push(resource)
    } catch (error) {
      if (!skippable(error)) throw error
      skipped.push({ resource, reason: error.message })
    }
  }

  const ranked = new Map<string, { item: SearchAllItem; score: number }>()
  for (const list of lists)
    list.forEach((item, rank) => {
      const held = ranked.get(item.ref) ?? { item, score: 0 }
      held.score += 1 / (RRF_K + rank + 1)
      ranked.set(item.ref, held)
    })
  const ordered = [...ranked.values()].sort((a, b) => b.score - a.score).map(({ item }) => item)
  const more = hasMore || ordered.length > window
  return {
    query: request.text,
    items: ordered.slice(offset, window),
    hasMore: more,
    ...(more && window <= MAX_SEARCH_OFFSET ? { nextOffset: window } : {}),
    searched,
    accounts,
    skipped,
    ...(notes === undefined ? {} : { notes }),
    ...(server === undefined ? {} : { server }),
  }
}
