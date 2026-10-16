import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { allAnswer, notesAnswer, offsetOf, SOURCE_SEARCHED } from "../../cli/messenger/search-answers.js"
import { searchNotesOf } from "../../services/notes-search.js"
import { searchServices } from "../search-sync.js"
import { type AnyTool, limit, READ, tool } from "../tool.js"
import {
  answerMessagesSearch,
  backendArgs,
  backendInputs,
  MESSAGES_SEARCH_DESCRIPTION,
  messagesSearchInput,
  page,
} from "./search.js"

const text = v.pipe(v.string(), v.minLength(1), v.description("the query, in the strict Lucene language"))
const exact = v.optional(
  v.pipe(v.boolean(), v.description("bare words and quotes match their exact form only; meaning is not searched")),
)
const timezone = v.optional(v.pipe(v.string(), v.description("the IANA timezone for calendar date boundaries")))

/** One tool per `search` leaf; `search_all` is the one an agent reaches for first. */
export const searchTools = (messenger: Messenger): Record<string, AnyTool> => ({
  search_all: tool({
    title: "Search messages and notes",
    description:
      "Messenger messages and notes held in the local store, merged best first — only these two kinds, and one " +
      "meeting account when `source` names it; mail is memo's (its search_mail), and tasks, people, memories, " +
      "projects, organizations and decisions are not searched here. Use it when you do not know where something was " +
      "written. When you know the kind, call its own tool: search_messages, search_notes, or search_conversations to " +
      "find by meaning. An empty answer means neither holds it: try the kind's own tool, looser words or search by " +
      "meaning before you conclude it was never written. Where the messenger's server can search, it is asked for " +
      "messages too, as search_messages asks it (backend=both by default; archive for the local store only; server " +
      "for the server's hits only) — notes are local only. Each item says its kind (message, note), ref (msg:… or " +
      "note:…), provider and account. A query field one kind lacks skips that kind and meta.issues names it; `only` " +
      "narrows the kinds. `source` names the accounts: provider:account as an item shows it, a provider, a kind or " +
      "group:<name>; each kind reads its own of them, and meta.issues names an entry no kind reads. Meetings are read " +
      "only when `source` names one meeting account (zoom:<account>, zoom, meetings, or all when one account holds " +
      "meetings): its transcripts, chat and summaries join in as kind meeting, with offset_ms into the meeting, and a " +
      "null timestamp when the start is unknown; otherwise meta.issues says meetings were not searched. Returns " +
      "{ items, page, next?, missing?, meta }; meta.accounts lists every account read as provider:account; a missing " +
      "entry says when a bounded meeting scan stopped before it could tell whether more match.",
    input: v.object({
      // Typed as present so the answer code reads them; offered only where the server can search.
      ...((messenger.serverSearch ? backendInputs : {}) as typeof backendInputs),
      text,
      page,
      only: v.optional(
        v.pipe(
          v.array(v.picklist(SOURCE_SEARCHED)),
          v.minLength(1),
          v.description("only these kinds: messages, notes; meetings when `source` names a meeting account"),
        ),
      ),
      source: v.optional(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.description(
            "only these accounts, comma-separated: provider:account as an item shows it, a provider, a kind or group:<name>",
          ),
        ),
      ),
      max_meetings: v.optional(
        v.pipe(
          v.union([v.pipe(v.number(), v.integer(), v.minValue(1)), v.literal("all")]),
          v.description(
            "how many of the meeting account's meetings to look through, newest first, or all (default 100)",
          ),
        ),
      ),
      exact,
      timezone,
      limit,
    }),
    annotations: { ...READ, openWorldHint: Boolean(messenger.serverSearch) },
    output: { entity: "hit", list: true },
    stored: async (store, account, args, defaults, connect) => {
      const network = Boolean(messenger.serverSearch) && args.backend !== "archive"
      const services = searchServices(messenger, store, account, defaults, network ? connect : undefined)
      const size = args.limit ?? defaults.limit
      const offset = offsetOf(args.page, size)
      const request = {
        text: args.text,
        limit: size,
        ...(offset === undefined ? {} : { offset }),
        ...(args.exact ? { exact: true } : {}),
        ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
        ...backendArgs(args),
        env: defaults.env,
        ...(defaults.signal === undefined ? {} : { signal: defaults.signal }),
      }
      const found = await services.messages.searchAllWithMeetings({
        ...request,
        only: args.only ?? SOURCE_SEARCHED,
        ...(args.source === undefined ? {} : { source: args.source }),
        ...(args.max_meetings === undefined ? {} : { maxMeetings: args.max_meetings }),
      })
      const again = {
        query: args.text,
        ...(args.only === undefined ? {} : { only: args.only.join(",") }),
        ...(args.source === undefined ? {} : { source: args.source }),
        ...(args.max_meetings === undefined ? {} : { max_meetings: args.max_meetings }),
        ...(args.exact ? { exact: true } : {}),
        ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
      }
      return allAnswer("search all", found, { limit: size, page: args.page ?? 1, again }, args.exact === true)
    },
  }),

  search_messages: tool({
    title: "Search messenger messages",
    description: MESSAGES_SEARCH_DESCRIPTION,
    input: messagesSearchInput(messenger),
    annotations: { ...READ, openWorldHint: Boolean(messenger.serverSearch) },
    output: { entity: "message.hit", list: true },
    stored: (store, account, args, defaults, connect) => {
      const network = args.sync_first || (Boolean(messenger.serverSearch) && args.backend !== "archive")
      const services = searchServices(messenger, store, account, defaults, network ? connect : undefined)
      return answerMessagesSearch(services.messages, args, defaults, services.searches)
    },
  }),

  search_notes: tool({
    title: "Search notes",
    description:
      "Search the notes — written in memo, or imported from a notes folder — by words and, with the local text " +
      "model, by meaning. Each item says which found it (found_by) and what it links to (links). source:internal in " +
      "text keeps the notes written in memo, source:file those from a notes folder. The `source` input narrows " +
      "which accounts are read: notes:internal for notes written in memo, notes:<folder id> as an item's folder_id shows it, or a list " +
      "with group:<name>; an entry naming none is in meta.issues. `filter` is a query every item must also match, " +
      "tag:work among them, and leaves the search by meaning as it is. Returns { items, page, next?, missing?, meta }.",
    input: v.object({
      text,
      source: v.optional(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.description(
            "only these notes accounts, comma-separated: notes:internal, notes:<folder id>, or group:<name>",
          ),
        ),
      ),
      filter: v.optional(v.pipe(v.string(), v.description("a query every hit must also match"))),
      page,
      exact,
      timezone,
      limit,
    }),
    annotations: { ...READ, openWorldHint: false },
    output: { entity: "note.hit", list: true },
    stored: async (store, account, args, defaults) => {
      const size = args.limit ?? defaults.limit
      const offset = offsetOf(args.page, size)
      const found = await searchNotesOf(store, account, args.text, {
        limit: size,
        command: messenger.app.command,
        env: defaults.env,
        ...(offset === undefined ? {} : { offset }),
        ...(args.source === undefined ? {} : { accounts: args.source }),
        app: messenger.app,
        ...(args.filter === undefined ? {} : { filter: args.filter }),
        ...(args.exact ? { exact: true } : {}),
        ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
      })
      const again = {
        query: args.text,
        ...(args.source === undefined ? {} : { source: args.source }),
        ...(args.filter === undefined ? {} : { filter: args.filter }),
        ...(args.exact ? { exact: true } : {}),
        ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
      }
      return notesAnswer("search notes", found, { limit: size, page: args.page ?? 1, again }, args.exact === true)
    },
  }),
})
