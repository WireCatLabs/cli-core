import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { messagesAnswer, offsetOf } from "../../cli/messenger/search-answers.js"
import { syncsFirst } from "../../cli/messenger/search-sync-options.js"
import { countsAnswer } from "../../cli/messenger/stats-answers.js"
import { parseDuration } from "../../domain/duration.js"
import type { MessagesService, SearchFound } from "../../services/messages.js"
import { MAX_SEARCH_OFFSET } from "../../services/messages-archive-search.js"
import type { SearchKind } from "../../services/search-kind.js"
import type { SearchParams } from "../../services/search-record.js"
import type { SearchesService } from "../../services/searches.js"
import { syncInputs } from "../search-sync.js"
import { threadArgs, threadInputs } from "../thread-options.js"
import { chatOf, limit } from "../tool.js"

const EXACT = "bare words and quotes match their exact form only, as exact:word does; not with an AST"

export const MESSAGES_SEARCH_DESCRIPTION =
  "Use discover=true for partial lexical evidence and eligible replies to natural questions in the local archive, without model downloads; inspect each item's discovery.missing_terms and its context before answering. Explicit syntax stays strict, and ranking is not answer confidence. Search the local store, and the messenger's server where it can search, using the Lucene 9.12.3 profile, default AND, with strict Boolean matching. chat: narrows to one chat; has:voice, has:file and NOT has:attachment to voice messages, files or text alone. `saved` runs a saved search (`searches list`) or an earlier run (`searches history`). With sync_first, first fetch new messages within max_chats (5), sync_time (30s), max_messages (500), under messages.sync-first permission. thread=true puts each hit's bounded parent/reply graph in its context; thread_hops, thread_messages, thread_bytes, thread_within set its bounds. Guide: https://github.com/WireCatLabs/cli-core/blob/main/docs/search/query-language.md. Text words and quoted phrases match every form of their words (Snowball stems, exact forms ranked first); exact:word, or exact=true, matches the exact form only. A bare word also matches voice transcripts, file names and file text; each item's matched_in says where (text, transcript, filename, file) and its excerpt comes from there; items with matched_in picture follow the text hits on the first page: pictures found by what they show, where the profile turned picture search on; text:, transcript:, content: (file text), filename: narrow to one place. Without discover=true, where the messenger's server can search, it is also asked by default (backend=both; archive for the local store only) within server_time (5s), under messages.server-search: its hits are saved and re-checked by the same strict query, and each item's found_in says archive, server or both. Returns { items, page, next?, missing?, meta }: items are message hits; meta.accounts the accounts read. A missing entry with field coverage means the archive lacks messages: when nothing was found, run its next step (messages sync) or ask the owner before concluding the message does not exist."

const SYNC_SENTENCE =
  " With sync_first, first fetch new messages within max_chats (5), sync_time (30s), max_messages (500), under messages.sync-first permission."
const COVERAGE_SENTENCE =
  " A missing entry with field coverage means the archive lacks messages: when nothing was found, run its next step (messages sync) or ask the owner before concluding the message does not exist."

/** For a messenger that pushes its history (`history: "store"`): nothing to fetch first, no sync to suggest. */
export const messagesSearchDescription = (messenger: Pick<Messenger, "history">): string =>
  syncsFirst(messenger)
    ? MESSAGES_SEARCH_DESCRIPTION
    : MESSAGES_SEARCH_DESCRIPTION.replace(SYNC_SENTENCE, "").replace(
        COVERAGE_SENTENCE,
        " The archive holds what serve has kept since the account was linked: when nothing was found, ask the owner before concluding the message does not exist.",
      )

export const backendInputs = {
  backend: v.optional(
    v.pipe(
      v.picklist(["archive", "server", "both"]),
      v.description(
        "both (default), archive, or the messenger's server; server hits are saved and re-checked by the same strict query, each hit says its source; needs messages.server-search",
      ),
    ),
  ),
  server_time: v.optional(
    v.pipe(v.string(), v.description("how long to wait for the server, default 5s, at most 60s")),
  ),
}

export const backendArgs = (args: { backend?: "archive" | "server" | "both"; server_time?: string }) => ({
  ...(args.backend === undefined ? {} : { backend: args.backend }),
  ...(args.server_time === undefined ? {} : { server: { timeMs: parseDuration(args.server_time, "server_time") } }),
})

export const page = v.optional(
  v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(MAX_SEARCH_OFFSET),
    v.description("which page, from 1: the page a page.next step names"),
  ),
)

export const messagesSearchInput = (messenger: Messenger) =>
  v.object({
    page,
    // Typed as present so the answer code reads them; offered only where the server can search.
    ...((messenger.serverSearch ? backendInputs : {}) as typeof backendInputs),
    ...threadInputs,
    ...syncInputs,
    text: v.optional(v.pipe(v.string(), v.description("the query, in Lucene syntax"))),
    ast: v.optional(v.unknown()),
    discover: v.optional(
      v.pipe(
        v.boolean(),
        v.description(
          "partial lexical discovery with eligible replies in the local archive; use for questions when wording is uncertain; hits are evidence, not confirmed answers",
        ),
      ),
    ),
    timezone: v.optional(v.string()),
    source: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description("a messenger held on this machine; personal, bots or all — as in: in text"),
      ),
    ),
    newest: v.optional(v.pipe(v.boolean(), v.description("newest first instead of best first"))),
    exact: v.optional(v.pipe(v.boolean(), v.description(EXACT))),
    context: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(20), v.description("messages around each hit")),
    ),
    limit,
    saved: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description(
          "run a saved search (name) or an earlier run (id); text is AND-ed to it, other arguments replace its own",
        ),
      ),
    ),
  })

export const syncArgs = (args: {
  sync_first?: boolean
  max_chats?: number
  sync_time?: string
  max_messages?: number
}) =>
  args.sync_first
    ? {
        syncFirst: {
          ...(args.max_chats === undefined ? {} : { maxChats: args.max_chats }),
          ...(args.sync_time === undefined ? {} : { timeMs: parseDuration(args.sync_time, "sync_time") }),
          ...(args.max_messages === undefined ? {} : { maxMessages: args.max_messages }),
        },
      }
    : {}

export type MessagesSearchArgs = v.InferOutput<ReturnType<typeof messagesSearchInput>>

const typedOf = (args: Record<string, unknown>): SearchParams =>
  Object.fromEntries(
    ["text", "discover", "language", "timezone", "source", "newest", "exact", "context", "limit", "by"].flatMap(
      (key) => (args[key] === undefined ? [] : [[key, args[key]]]),
    ),
  )

/** `saved` needs the searches service; a host that mounts the tool without it refuses `saved` rather than ignore it. */
const resolveSaved = async (
  searches: Pick<SearchesService, "resolve"> | undefined,
  args: { saved?: string; ast?: unknown } & Record<string, unknown>,
) => {
  if (args.saved === undefined) return undefined
  if (!searches) throw new CliError("validation_error", "saved searches are not available on this server")
  if (args.ast !== undefined) throw new CliError("validation_error", "with saved, give more words as text, not an AST")
  return searches.resolve(args.saved, typedOf(args))
}

const offsetArg = (page: number | undefined, limit: number) => {
  const offset = offsetOf(page, limit)
  return offset === undefined ? {} : { offset }
}

export const answerMessagesSearch = async (
  messages: Pick<MessagesService, "search">,
  given: MessagesSearchArgs,
  defaults: { limit: number; signal?: AbortSignal },
  searches?: Pick<SearchesService, "resolve">,
  kind: SearchKind = "messages",
) => {
  const args = given
  const again = {
    ...(args.text === undefined ? {} : { query: args.text }),
    ...(args.saved === undefined ? {} : { saved: args.saved }),
    ...(args.source === undefined ? {} : { source: args.source }),
    ...(args.discover ? { discover: true } : {}),
    ...(args.exact ? { exact: true } : {}),
    ...(args.newest ? { newest: true } : {}),
    ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
  }
  const answer = (found: SearchFound, limit: number) =>
    messagesAnswer(`search ${kind}`, found, { limit, page: args.page ?? 1, again }, args.text)
  const resolved = await resolveSaved(searches, args)
  if (resolved) {
    const { params } = resolved
    const size = params.limit ?? defaults.limit
    const found = await messages.search({
      kind,
      ...syncArgs(args),
      ...backendArgs(args),
      ...threadArgs(args),
      ...(params.text === undefined ? {} : { text: params.text }),
      ...(params.ast === undefined ? {} : { ast: params.ast }),
      ...(params.discover === undefined ? {} : { discover: params.discover }),
      signal: defaults.signal,
      ...(params.timezone === undefined ? {} : { timezone: params.timezone }),
      limit: size,
      ...offsetArg(args.page, size),
      newest: params.newest === true,
      ...(params.exact ? { exact: true } : {}),
      context: params.context ?? 0,
      ...(params.chat === undefined ? {} : { chat: params.chat }),
      ...(params.source === undefined ? {} : { source: params.source }),
      saved: resolved.id,
    })
    return answer(found, size)
  }
  if (args.text === undefined && args.ast === undefined)
    throw new CliError("validation_error", "give search text, a versioned AST, or saved")
  const size = args.limit ?? defaults.limit
  const found = await messages.search({
    kind,
    ...syncArgs(args),
    ...backendArgs(args),
    ...threadArgs(args),
    ...(args.text === undefined ? {} : { text: args.text }),
    ...(args.ast === undefined ? {} : { ast: args.ast }),
    ...(args.discover === undefined ? {} : { discover: args.discover }),
    signal: defaults.signal,
    ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
    limit: size,
    ...offsetArg(args.page, size),
    newest: args.newest === true,
    ...(args.exact ? { exact: true } : {}),
    context: args.context ?? 0,
    ...(args.source === undefined ? {} : { source: args.source }),
  })
  return answer(found, size)
}

export const MESSAGES_STATS_DESCRIPTION =
  "Count what a strict Lucene query matches in the local store, by chat, sender, calendar day or hour (in the timezone). Each message is counted once; no text means every stored message. Words match every form, as in `search messages`; exact=true counts exact forms only. Counts are lower bounds where coverage is not complete. sync_first optionally refreshes within max_chats, sync_time and max_messages; failed refreshes keep counts with stale coverage and refreshed details. Returns { item: { by, total, rows: [{ key, ref?, name, count }] } }; meta.truncated marks more rows than limit, and missing names a chat the store does not hold whole."

export const messagesStatsDescription = (messenger: Pick<Messenger, "history">): string =>
  syncsFirst(messenger)
    ? MESSAGES_STATS_DESCRIPTION
    : MESSAGES_STATS_DESCRIPTION.replace(
        " sync_first optionally refreshes within max_chats, sync_time and max_messages; failed refreshes keep counts with stale coverage and refreshed details.",
        "",
      )

export const messagesStatsInput = (messenger: Messenger) =>
  v.object({
    ...syncInputs,
    text: v.optional(v.pipe(v.string(), v.minLength(1), v.description("a strict Lucene query; omit to count all"))),
    ast: v.optional(v.unknown()),
    exact: v.optional(v.pipe(v.boolean(), v.description(EXACT))),
    by: v.optional(v.picklist(["chat", "sender", "day", "hour"])),
    timezone: v.optional(v.string()),
    chat: v.optional(chatOf(messenger)),
    source: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description("a messenger held on this machine; personal, bots or all — as in: in text"),
      ),
    ),
    limit,
    saved: v.optional(
      v.pipe(
        v.string(),
        v.minLength(1),
        v.description(
          "run a saved search (name) or an earlier run (id); text is AND-ed to it, other arguments replace its own",
        ),
      ),
    ),
  })

export const answerMessagesStats = async (
  messages: Pick<MessagesService, "stats">,
  args: v.InferOutput<ReturnType<typeof messagesStatsInput>>,
  defaults: { limit: number; signal?: AbortSignal },
  searches?: Pick<SearchesService, "resolve">,
) => {
  const resolved = await resolveSaved(searches, args)
  const params: SearchParams = resolved?.params ?? args
  const size = params.limit ?? defaults.limit
  const stats = await messages.stats({
    ...syncArgs(args),
    ...(params.text === undefined ? {} : { text: params.text }),
    ...(params.ast === undefined ? {} : { ast: params.ast }),
    by: params.by ?? "chat",
    ...(params.exact ? { exact: true } : {}),
    signal: defaults.signal,
    ...(params.timezone === undefined ? {} : { timezone: params.timezone }),
    limit: size,
    ...(params.chat === undefined ? {} : { chat: params.chat }),
    ...(params.source === undefined ? {} : { source: params.source }),
    ...(resolved ? { saved: resolved.id } : {}),
  })
  return countsAnswer(stats)
}
