import * as v from "valibot"
import type { Messenger } from "../../cli/messenger/context.js"
import { SAVE_NEXT_STEPS } from "../../meetings/index.js"
import { atDetail } from "../../output-detail.js"
import { searchNotesOf } from "../../services/notes-search.js"
import { RESOURCES_SEARCHED_WITH_MEETINGS } from "../../services/search-all-meetings.js"
import { searchServices } from "../search-sync.js"
import { type AnyTool, limit, READ, tool } from "../tool.js"
import {
  answerMessagesSearch,
  backendArgs,
  backendInputs,
  MESSAGES_SEARCH_DESCRIPTION,
  type MessagesSearchArgs,
  mailSearchInput,
  messagesSearchInput,
  offset,
} from "./search.js"

const text = v.pipe(v.string(), v.minLength(1), v.description("the query, in the strict Lucene language"))
const exact = v.optional(
  v.pipe(v.boolean(), v.description("bare words and quotes match their exact form only; meaning is not searched")),
)
const timezone = v.optional(v.pipe(v.string(), v.description("the IANA timezone for calendar date boundaries")))

/** One tool per `search` leaf; `search_all` is the one an agent reaches for first. */
export const searchTools = (messenger: Messenger): Record<string, AnyTool> => ({
  search_all: tool({
    nextSteps: SAVE_NEXT_STEPS,
    title: "Search messages, mail and notes",
    description:
      "Messenger messages, mail and notes held in the local store, merged best first — only these three kinds, and " +
      "one meeting account when `source` names it; tasks, people, memories, projects, organizations and decisions are not " +
      "searched here. Use it when you do not know where something was written. When you know the kind, call its own " +
      "tool: search_mail (with from:, to:, cc:, subject:, mailbox:, is:unread), search_messages, search_notes, or " +
      "search_conversations to find by meaning. An empty answer means none of the three holds it: try the kind's own " +
      "tool, looser words or search by meaning before you conclude it was never written. Where the messenger's server can search, it is asked for messages too, as search_messages asks it " +
      "(backend=both by default; archive for the local store only; server for the server's hits only) — mail and " +
      "notes are local only. Each item says its kind (message, mail, note), ref (msg:… or note:…), provider and account. A query " +
      "field one kind lacks skips that kind and `skipped` says why; `only` narrows the kinds. `source` names the " +
      "accounts: provider:account as an item shows it, a provider, a kind or group:<name>; each kind reads its own of " +
      "them, and `skipped` names an entry no kind reads. Meetings are read only when `source` names one meeting " +
      "account (zoom:<account>, zoom, meetings, or all when one account holds meetings): its transcripts, chat and " +
      "summaries join in as kind meeting, with meetingId, scope, id and startMs instead of a ref, and a null timestamp " +
      "when the start is unknown; otherwise `skipped` says meetings were not searched. Returns { query, items, hasMore, searched, accounts, skipped, notes?, " +
      "meetings?, server? }; accounts lists every account read as { resource, provider, account }; " +
      "hasMore is null when a bounded meeting scan could not tell.",
    input: v.object({
      // Typed as present so the answer code reads them; offered only where the server can search.
      ...((messenger.serverSearch ? backendInputs : {}) as typeof backendInputs),
      text,
      offset,
      only: v.optional(
        v.pipe(
          v.array(v.picklist(RESOURCES_SEARCHED_WITH_MEETINGS)),
          v.minLength(1),
          v.description("only these kinds: messages, mail, notes; meetings when `source` names a meeting account"),
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
    stored: (store, account, args, defaults, connect) => {
      const network = Boolean(messenger.serverSearch) && args.backend !== "archive"
      const services = searchServices(messenger, store, account, defaults, network ? connect : undefined)
      const request = {
        text: args.text,
        limit: args.limit ?? defaults.limit,
        ...(args.offset === undefined ? {} : { offset: args.offset }),
        ...(args.exact ? { exact: true } : {}),
        ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
        ...backendArgs(args),
        env: defaults.env,
        ...(defaults.signal === undefined ? {} : { signal: defaults.signal }),
      }
      return services.messages.searchAllWithMeetings({
        ...request,
        ...(args.only === undefined ? {} : { only: args.only }),
        ...(args.source === undefined ? {} : { source: args.source }),
        ...(args.max_meetings === undefined ? {} : { maxMeetings: args.max_meetings }),
      })
    },
  }),

  search_messages: tool({
    nextSteps: SAVE_NEXT_STEPS,
    title: "Search messenger messages",
    description: MESSAGES_SEARCH_DESCRIPTION,
    input: messagesSearchInput(messenger),
    annotations: { ...READ, openWorldHint: Boolean(messenger.serverSearch) },
    stored: (store, account, args, defaults, connect) => {
      const network = args.sync_first || (Boolean(messenger.serverSearch) && args.backend !== "archive")
      const services = searchServices(messenger, store, account, defaults, network ? connect : undefined)
      return answerMessagesSearch(services.messages, args, defaults, services.searches).then((found) =>
        atDetail(found, args.detail),
      )
    },
  }),

  search_mail: tool({
    nextSteps: SAVE_NEXT_STEPS,
    title: "Search mail",
    description:
      "Search the mail imported into the local store (memo mail <account> import), in the same query language as " +
      "search_messages; one mail thread is one chat. It reads every mail account; `source` narrows it: email:<address>, " +
      "or a list with group:<name>; an entry naming no mailbox is in `skipped`. Returns { items, page, limit, hasMore, " +
      "completeness, query, accounts, skipped? }; accounts lists the mailboxes read as { resource, provider, account }.",
    input: mailSearchInput(messenger),
    annotations: { ...READ, openWorldHint: false },
    stored: (store, account, args, defaults) => {
      const services = searchServices(messenger, store, account, defaults)
      return answerMessagesSearch(services.messages, args as MessagesSearchArgs, defaults, undefined, "mail").then(
        (found) => atDetail(found, args.detail),
      )
    },
  }),

  search_notes: tool({
    nextSteps: SAVE_NEXT_STEPS,
    title: "Search notes",
    description:
      "Search the notes — written in memo, or imported from a notes folder — by words and, with the local text " +
      "model, by meaning. Each hit says which found it (foundBy) and what it links to; `linked` lists the people, " +
      "entities and notes the hits link most. `source` narrows which: notes:internal for notes written in memo, " +
      "notes:<folder id> as a hit's folderId shows it, or a list with group:<name>; an entry naming none is in " +
      "`skipped`. Returns { query, by, meaningSkipped?, hits, hasMore, nextOffset?, linked, accounts, skipped }.",
    input: v.object({
      text,
      type: v.optional(
        v.pipe(v.picklist(["internal", "file"]), v.description("internal: written in memo; file: from a notes folder")),
      ),
      source: v.optional(
        v.pipe(
          v.string(),
          v.minLength(1),
          v.description(
            "only these notes accounts, comma-separated: notes:internal, notes:<folder id>, or group:<name>",
          ),
        ),
      ),
      tag: v.optional(v.pipe(v.string(), v.description("only notes with this tag"))),
      filter: v.optional(v.pipe(v.string(), v.description("a query every hit must also match"))),
      offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1000))),
      exact,
      timezone,
      limit,
    }),
    annotations: { ...READ, openWorldHint: false },
    stored: (store, account, args, defaults) =>
      searchNotesOf(store, account, args.text, {
        limit: args.limit ?? defaults.limit,
        command: messenger.app.command,
        env: defaults.env,
        ...(args.offset === undefined ? {} : { offset: args.offset }),
        ...(args.type === undefined ? {} : { source: args.type }),
        ...(args.source === undefined ? {} : { accounts: args.source }),
        app: messenger.app,
        ...(args.tag === undefined ? {} : { tag: args.tag }),
        ...(args.filter === undefined ? {} : { filter: args.filter }),
        ...(args.exact ? { exact: true } : {}),
        ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
      }),
  }),
})
