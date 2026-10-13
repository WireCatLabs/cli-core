import { CliError, singleLine } from "@wirecat/cli-base"
import { Command } from "commander"
import { SAVE_HELP } from "../../meetings/index.js"
import { searchNotesOf } from "../../services/notes-search.js"
import {
  RESOURCES_SEARCHED_WITH_MEETINGS,
  type ResourceWithMeetings,
  type SearchAllIncludingMeetingsFound,
} from "../../services/search-all-meetings.js"
import type { Note } from "../../store/index.js"
import { positiveCount } from "../paging.js"
import { removedOptions } from "../removed-options.js"
import { type Messenger, messengerContext } from "./context.js"
import { conversationsSearchCommand } from "./conversations-command.js"
import { messagesSearchCommand, wholeCount } from "./messages-search-command.js"
import { backendOptions, backendRequest, noteServer } from "./search-backend-options.js"
import { topicsSearchCommand } from "./topics-command.js"

const onlyOf = (value: string): ResourceWithMeetings[] => {
  const chosen = value.split(",").map((one) => one.trim())
  const unknown = chosen.find((one) => !(RESOURCES_SEARCHED_WITH_MEETINGS as readonly string[]).includes(one))
  if (unknown !== undefined || chosen.length === 0)
    throw new CliError(
      "validation_error",
      `--only takes ${RESOURCES_SEARCHED_WITH_MEETINGS.join(", ")}, separated by commas; meetings when --source names a meeting account`,
    )
  return [...new Set(chosen)] as ResourceWithMeetings[]
}

const lineOf = (item: SearchAllIncludingMeetingsFound["items"][number]): string =>
  item.kind === "meeting"
    ? `meeting · ${item.provider} · ${singleLine(item.title ?? "")}  ${item.ref}\n  ${item.timestamp ?? "time unknown"}  ${singleLine(item.text).slice(0, 200)}\n`
    : `${item.kind} · ${item.provider} · ${singleLine(item.title ?? "")}  ${item.ref}\n  ${item.timestamp}${item.from?.name ? `  ${singleLine(item.from.name)}` : ""}  ${singleLine(item.text)}\n`

const maxMeetingsOf = (value: string): number | "all" => {
  if (value === "all") return "all"
  if (!/^[1-9]\d*$/.test(value))
    throw new CliError("validation_error", "--max-meetings takes a whole number from 1, or all")
  return Number(value)
}

const noteTypeOf = (value: string): Note["source"] => {
  if (value !== "internal" && value !== "file")
    throw new CliError("validation_error", "--type takes internal (written in memo) or file (from a notes folder)")
  return value
}

const allCommand = (messenger: Messenger): Command => {
  const command = new Command("all")
    .description(
      (messenger.serverSearch
        ? "search messenger messages, mail and notes in the local store, and the messenger's server for messages " +
          "(--backend; mail and notes are local only)"
        : "search messenger messages, mail and notes in the local store") +
        ", and a meeting account's transcripts when --source names one — best match first; not tasks, people, memories or " +
        "projects. Use it when you do not know where something was written; search mail, messages or notes reads one " +
        "kind with all its fields",
    )
    .argument("<query...>", 'strict Lucene query: words, "phrases", AND/OR/NOT, field groups and date ranges')
    .addHelpText("after", SAVE_HELP)
    .option(
      "--only <resources>",
      "only these resources, separated by commas: messages, mail, notes; meetings when --source names a meeting account",
      onlyOf,
    )
    .option(
      "--source <accounts>",
      "only these accounts, separated by commas: provider:account as a hit shows it, a provider, a kind or " +
        "group:<name>; each resource reads the ones of its kind, and meetings only when it names one",
    )
    .option(
      "--max-meetings <n|all>",
      "how many of the meeting account's meetings to look through, newest first; all looks through every one (default 100)",
      maxMeetingsOf,
    )
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .option("--offset <n>", "skip this many, for the next page", wholeCount)
    .option("--exact", "bare words and quotes match their exact form only, as exact:word does")
    .option("--timezone <zone>", "the IANA timezone for calendar date boundaries")
  removedOptions(command, {
    "--meetings":
      "--source names the meeting account: --source all reads every account and its meetings, " +
      "--source zoom:<account> or --source meetings the meetings alone",
  })
  return backendOptions(command, messenger).action(async function (this: Command, words: string[]) {
    const context = messengerContext(this, messenger)
    const { only, source, maxMeetings, limit, offset, exact, timezone } = this.opts<{
      only?: ResourceWithMeetings[]
      source?: string
      maxMeetings?: number | "all"
      limit?: number
      offset?: number
      exact?: boolean
      timezone?: string
    }>()
    const found = await context.withServices<SearchAllIncludingMeetingsFound>((services) =>
      services.messages.searchAllWithMeetings({
        text: words.join(" "),
        limit: limit ?? context.settings.limit,
        ...(offset === undefined ? {} : { offset }),
        ...(exact ? { exact: true } : {}),
        ...(timezone === undefined ? {} : { timezone }),
        ...backendRequest(this),
        env: context.env,
        ...(only === undefined ? {} : { only }),
        ...(source === undefined ? {} : { source }),
        ...(maxMeetings === undefined ? {} : { maxMeetings }),
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
    if (found.meetings?.complete === false)
      context.renderer.note(
        `meetings: stopped after ${found.meetings.meetingsScanned} meetings; more may match — --max-meetings all looks through every one`,
      )
    if (context.format === "jsonl") return context.renderer.stream(found.items)
    if (context.format !== "pretty") return context.renderer.result(found)
    context.streams.data(found.items.map(lineOf).join(""))
    if (found.items.length === 0)
      context.renderer.note(
        found.server && !found.server.skipped
          ? "nothing found in the local store or on the messenger's server"
          : "nothing found in what the local store holds",
      )
  })
}

const notesCommand = (messenger: Messenger): Command =>
  new Command("notes")
    .description(
      "search the notes — written in memo, or imported from a notes folder — by words and, with the local " +
        "text model, by meaning; each hit says which found it and what it links to",
    )
    .argument("<query...>", 'strict Lucene query: words, "phrases", AND/OR/NOT, tag: and date ranges')
    .option("--type <internal|file>", "only notes written in memo, or only notes from a folder", noteTypeOf)
    .option(
      "--source <accounts>",
      "only these notes accounts, separated by commas: notes:internal for notes written in memo, notes:<folder id> " +
        "as a hit shows it, notes, documents or group:<name>",
    )
    .option("--tag <tag>", "only notes with this tag")
    .option("--filter <query>", "a query every hit must also match; it does not change the search by meaning")
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .option("--offset <n>", "skip this many, for the next page", (value: string) => Number(value))
    .option("--exact", "words as written only; meaning is not searched")
    .option("--timezone <zone>", "the IANA timezone for calendar date boundaries")
    .action(async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger)
      const options = this.opts<{
        type?: Note["source"]
        source?: string
        tag?: string
        filter?: string
        limit?: number
        offset?: number
        exact?: boolean
        timezone?: string
      }>()
      const found = await context.withStore((store, account) =>
        searchNotesOf(store, account, words.join(" "), {
          limit: options.limit ?? context.settings.limit,
          command: messenger.app.command,
          env: context.env,
          ...(options.offset === undefined ? {} : { offset: options.offset }),
          ...(options.type === undefined ? {} : { source: options.type }),
          ...(options.source === undefined ? {} : { accounts: options.source }),
          app: messenger.app,
          ...(options.tag === undefined ? {} : { tag: options.tag }),
          ...(options.filter === undefined ? {} : { filter: options.filter }),
          ...(options.exact ? { exact: true } : {}),
          ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
        }),
      )
      if (context.format === "pretty")
        context.renderer.note(`searched: ${found.accounts.map(({ account }) => `notes:${account}`).join(", ")}`)
      for (const { source, reason } of found.skipped) context.renderer.note(`${source} not searched: ${reason}`)
      if (found.meaningSkipped) context.renderer.note(`by words only: ${found.meaningSkipped}`)
      if (context.format === "jsonl") return context.renderer.stream(found.hits)
      if (context.format !== "pretty") return context.renderer.result(found)
      context.streams.data(
        found.hits
          .map(
            (hit) =>
              `${singleLine(hit.title ?? hit.path ?? hit.ref)}  ${hit.ref}  (${hit.foundBy.join(", ")})\n  ${singleLine(hit.line)}\n`,
          )
          .join(""),
      )
      if (found.hits.length === 0) context.renderer.note("no note matches")
    })

/**
 * `search <resource>`: every search of the tool, one leaf per resource (STANDARD.md, "Search
 * hierarchy"). `topics` only where the CLI has forum topics.
 */
export const searchCommand = (messenger: Messenger, { topics = false }: { topics?: boolean } = {}): Command => {
  const search = new Command("search").description(
    "find things by text: one resource when you know it (mail, messages, notes), or search all across messages, mail and notes",
  )
  search
    .addCommand(allCommand(messenger))
    .addCommand(messagesSearchCommand(messenger, "messages"))
    .addCommand(messagesSearchCommand(messenger, "mail"))
    .addCommand(
      removedOptions(notesCommand(messenger), {
        "--folder": "--source notes:<folder id> names the folder, and notes:internal the notes written in memo",
      }),
    )
    .addCommand(conversationsSearchCommand(messenger))
  if (topics) search.addCommand(topicsSearchCommand(messenger))
  return search
}
