import { CliError, singleLine } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { SAVE_HELP } from "../../meetings/index.js"
import { searchNotesOf } from "../../services/notes-search.js"
import type { SearchAllFound, SearchAllItem } from "../../services/search-all.js"
import { LOCAL_READ, REMOTE_READ } from "../effects.js"
import { renderAnswer } from "../envelope.js"
import { withOptionHints } from "../option-hints.js"
import { positiveCount } from "../paging.js"
import { runsSearchCommand } from "../runs/search-command.js"
import { commandAt } from "../steps.js"
import { type Messenger, messengerContext } from "./context.js"
import { conversationsSearchCommand } from "./conversations-command.js"
import { historySkipsOf } from "./history-gaps.js"
import { messagesSearchCommand } from "./messages-search-command.js"
import {
  allAnswer,
  meaningNote,
  notesAnswer,
  offsetOf,
  SOURCE_SEARCHED,
  type SourceSearched,
  shownOf,
} from "./search-answers.js"
import { backendOptions, backendRequest, noteServer } from "./search-backend-options.js"
import { topicsSearchCommand } from "./topics-command.js"

export const searchAllOnlyOf = (value: string, allowed: readonly string[] = SOURCE_SEARCHED): SourceSearched[] => {
  const chosen = value.split(",").map((one) => one.trim())
  if (chosen.includes("mail"))
    throw new CliError(
      "validation_error",
      "mail is searched by the separate memo CLI: install @wirecat/cli-memo, then `memo search mail …`",
    )
  const unknown = chosen.find((one) => !allowed.includes(one))
  if (unknown !== undefined || chosen.length === 0)
    throw new CliError("validation_error", `--only takes ${allowed.join(", ")}, separated by commas`)
  return [...new Set(chosen)] as SourceSearched[]
}

/** One `search all` hit as a person reads it. */
export const searchAllLine = (item: SearchAllItem): string =>
  item.kind === "meeting"
    ? `meeting · ${item.provider} · ${singleLine(item.title ?? "")}  ${item.ref}\n  ${item.timestamp ?? "time unknown"}  ${singleLine(item.text).slice(0, 200)}\n`
    : `${item.kind} · ${item.provider} · ${singleLine(item.title ?? "")}  ${item.ref}${item.url ? `\n  ${singleLine(item.url)}` : ""}\n  ${item.timestamp}${item.from?.name ? `  ${singleLine(item.from.name)}` : ""}  ${singleLine(item.text)}\n`

/**
 * `search all`'s scope, paging and matching options, the same in every CLI that mounts it (WC-ACCT-8): a messenger's
 * and a calendar's.
 */
/** `allowed`: the resources `--only` takes, a CRM CLI's with `crm`. */
export const searchAllOptions = (command: Command, allowed: readonly string[] = SOURCE_SEARCHED): Command =>
  command
    .option("--only <resources>", `only these resources, separated by commas: ${allowed.join(", ")}`, (value: string) =>
      searchAllOnlyOf(value, allowed),
    )
    .option(
      "--source <accounts>",
      "only these accounts, separated by commas: provider:account as a hit shows it, a provider, a kind or " +
        "group:<name>; each resource reads the ones of its kind",
    )
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .option("--page <n>", "which page, starting at 1", positiveCount("--page"))
    .option("--exact", "bare words and quotes match their exact form only, as exact:word does")
    .option("--timezone <zone>", "the IANA timezone for calendar date boundaries")

const allCommand = (messenger: Messenger): Command => {
  const command = annotate(new Command("all"), { effects: REMOTE_READ, partial: true })
    .summary("search stored messages, notes, calendar events and meetings")
    .description(
      (messenger.serverSearch
        ? "search messenger messages and notes in the local store, and by default the messenger's server for " +
          "messages too (notes and events are local only; --backend archive or --offline keeps it to the local store)"
        : "search messenger messages and notes in the local store") +
        ", calendar events when the store holds a calendar" +
        ", and meeting transcripts, chat and summaries when it holds a meeting account — best match first; not mail (the separate memo CLI searches it: memo search mail), " +
        "tasks, people, memories or projects. Use it when you do not know where something was written; search messages " +
        "or notes reads one kind with all its fields",
    )
    .argument("<query...>", 'strict Lucene query: words, "phrases", AND/OR/NOT, field groups and date ranges')
    .addHelpText("after", SAVE_HELP)
    .addHelpText(
      "after",
      `transcript: narrows a message search to voice transcripts, content: to the text of files, filename: to their names — \`${messenger.app.command} search all 'content:invoice'\`.
--json: the list is items; each result's reference is ref, with its kind.`,
    )

  return backendOptions(annotate(searchAllOptions(command), { output: { entity: "hit" } }), messenger).action(
    async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger)
      const {
        only,
        source,
        limit: typed,
        page,
        exact,
        timezone,
      } = this.opts<{
        only?: SourceSearched[]
        source?: string
        limit?: number
        page?: number
        exact?: boolean
        timezone?: string
      }>()
      const limit = typed ?? context.settings.limit
      const offset = offsetOf(page, limit)
      const found = await context.withServices<SearchAllFound>((services) =>
        services.messages.searchAll({
          text: words.join(" "),
          limit,
          ...(offset === undefined ? {} : { offset }),
          ...(exact ? { exact: true } : {}),
          ...(timezone === undefined ? {} : { timezone }),
          ...backendRequest(this),
          env: context.env,
          only: only ?? SOURCE_SEARCHED,
          ...(only?.includes("meetings") ? { meetingsAsked: true } : {}),
          ...(source === undefined ? {} : { source }),
        }),
      )
      noteServer(context, found.server)
      if (context.format === "pretty")
        context.renderer.note(
          `searched: ${found.accounts.map(({ provider, account }) => `${provider}:${account}`).join(", ") || "nothing"}`,
        )
      for (const { resource, source, reason } of found.skipped)
        context.renderer.note(`${resource ?? source} not searched: ${reason}`)
      if (found.notes?.meaningSkipped) context.renderer.note(`notes by words only: ${found.notes.meaningSkipped}`)
      if (found.events?.meaningSkipped) context.renderer.note(`events by words only: ${found.events.meaningSkipped}`)
      if (found.messages?.meaningSkipped)
        context.renderer.note(`messages: ${meaningNote(found.messages.meaningSkipped, messenger.app.command)}`)
      const again = {
        query: words.join(" "),
        ...(only === undefined ? {} : { only: only.join(",") }),
        ...(source === undefined ? {} : { source }),
        ...(exact ? { exact: true } : {}),
        ...(timezone === undefined ? {} : { timezone }),
      }
      const skips = await context.withStore((store) => historySkipsOf(store, found.accounts)).catch(() => [])
      renderAnswer(
        this,
        context,
        allAnswer("search all", found, { limit, page: page ?? 1, again }, false, skips),
        () => {
          if (found.items.length === 0)
            context.renderer.note(
              found.server && !found.server.skipped
                ? "nothing found in the local store or on the messenger's server"
                : "nothing found in what the local store holds",
            )
          return found.items.map(searchAllLine).join("")
        },
      )
    },
  )
}

const notesCommand = (messenger: Messenger): Command =>
  annotate(new Command("notes"), { effects: LOCAL_READ, partial: true, output: { entity: "note", view: "hit" } })
    .summary("find stored notes by words and filters")
    .description(
      "search the notes — written in memo, or imported from a notes folder — by words and, with the local " +
        "text model, by meaning; each hit says which found it and what it links to",
    )
    .argument(
      "<query...>",
      'strict Lucene query: words, "phrases", AND/OR/NOT, tag:, source:internal (written in memo) or source:file ' +
        "(from a notes folder) and date ranges",
    )
    .addHelpText(
      "after",
      "Fields in the query or in --filter (tag:, date:, source:…) hold for every hit, found by words or by meaning; " +
        "only the words are searched by meaning, and a query of fields alone lists the matching notes, newest first — " +
        "'budget tag:work', 'date:today'. updated_at is the time date: reads: a Drive document's edit time. " +
        "--json: the list is items; each note's reference is ref.",
    )
    .option(
      "--source <accounts>",
      "only these notes accounts, separated by commas: notes:internal for notes written in memo, notes:<folder id> " +
        "as a hit shows it, notes, documents or group:<name>",
    )
    .option("--filter <query>", "a query every hit must also match, found by words or by meaning")
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .option("--page <n>", "which page, starting at 1", positiveCount("--page"))
    .option("--exact", "words as written only; meaning is not searched")
    .option("--timezone <zone>", "the IANA timezone for calendar date boundaries")
    .action(async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger)
      const options = this.opts<{
        source?: string
        filter?: string
        limit?: number
        page?: number
        exact?: boolean
        timezone?: string
      }>()
      const limit = options.limit ?? context.settings.limit
      const offset = offsetOf(options.page, limit)
      const found = await context.withStore((store, account) =>
        searchNotesOf(store, account, words.join(" "), {
          limit,
          command: messenger.app.command,
          env: context.env,
          ...(offset === undefined ? {} : { offset }),
          ...(options.source === undefined ? {} : { accounts: options.source }),
          app: messenger.app,
          ...(options.filter === undefined ? {} : { filter: options.filter }),
          ...(options.exact ? { exact: true } : {}),
          ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
        }),
      )
      if (context.format === "pretty")
        context.renderer.note(`searched: ${found.accounts.map(({ account }) => `notes:${account}`).join(", ")}`)
      for (const { source, reason } of found.skipped) context.renderer.note(`${source} not searched: ${reason}`)
      if (found.meaning_skipped) context.renderer.note(`by words only: ${found.meaning_skipped}`)
      const again = {
        query: words.join(" "),
        ...(options.source === undefined ? {} : { source: options.source }),
        ...(options.filter === undefined ? {} : { filter: options.filter }),
        ...(options.exact ? { exact: true } : {}),
        ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
      }
      renderAnswer(this, context, notesAnswer("search notes", found, { limit, page: options.page ?? 1, again }), () => {
        if (found.hits.length === 0) context.renderer.note("no note matches")
        const shown = shownOf(found.hits.length, ((options.page ?? 1) - 1) * limit, found.total)
        if (shown) context.renderer.note(shown)
        return found.hits
          .map(
            (hit) =>
              `${singleLine(hit.title ?? hit.path ?? hit.ref)}  ${hit.ref}  (${hit.found_by.join(", ")})${hit.url ? `\n  ${singleLine(hit.url)}` : ""}\n  ${singleLine(hit.excerpt)}\n`,
          )
          .join("")
      })
    })

/**
 * `search <resource>`: every search of the tool, one leaf per resource (STANDARD.md, "Search
 * hierarchy"). `topics` only where the CLI has forum topics.
 */
export const searchCommand = (messenger: Messenger, { topics = false }: { topics?: boolean } = {}): Command => {
  const search = new Command("search")
    .summary("search the local archive")
    .description(
      "find things by text: one resource when you know it (messages, notes), or search all across messages and notes; for mail, the separate memo CLI: memo search mail",
    )
  search
    .addCommand(allCommand(messenger))
    .addCommand(messagesSearchCommand(messenger))
    .addCommand(notesCommand(messenger))
    .addCommand(conversationsSearchCommand(messenger))
    .addCommand(runsSearchCommand(messenger.app))
  if (topics) search.addCommand(topicsSearchCommand(messenger))
  for (const [path, args] of Object.entries({
    all: "draft",
    conversations: '"Reviewing the project draft"',
    messages: "draft --limit 10",
    notes: "draft --limit 10",
    topics: '"Book club" draft',
  })) {
    const command = commandAt(search, path)
    if (command) annotate(command, { examples: [`${messenger.app.command} personal search ${path} ${args}`] })
  }
  for (const path of ["all", "messages"]) {
    const command = commandAt(search, path)
    if (command)
      withOptionHints(command, {
        "--chat": `search in one chat with chat:<chat> in the query: search ${path} 'chat:<chat> words'`,
      })
  }
  return search
}
