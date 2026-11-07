import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { outputFor } from "../../cli/context.js"
import { LOCAL_READ } from "../../cli/effects.js"
import type { Body } from "../../cli/envelope.js"
import { historySkipsOf } from "../../cli/messenger/history-gaps.js"
import { allAnswer, offsetOf, SOURCE_SEARCHED, type SourceSearched } from "../../cli/messenger/search-answers.js"
import { searchAllLine, searchAllOptions } from "../../cli/messenger/search-command.js"
import { deniedKinds } from "../../cli/search-left-out.js"
import { SAVE_HELP } from "../../meetings/index.js"
import type { AppIdentity } from "../../ports/app.js"
import { meaningLane } from "../../services/messages-meaning.js"
import { searchAllWithMeetings } from "../../services/search-all-meetings.js"
import { messagesOf } from "./bodies.js"
import type { CommandHelpers } from "./index.js"

interface SearchAllHelpers extends Pick<CommandHelpers, "within" | "zone" | "example"> {
  app: AppIdentity
}

const DEFAULT_LIMIT = 20

/**
 * `search all` beside `search events`: the messenger's shared search over the store, without a messenger server.
 * Events are the calendar's own kind and always read; meeting transcripts only when `--source` names a meeting account.
 */
export const addSearchAll = (searches: Command, { within, app, zone, example }: SearchAllHelpers): void => {
  const all = annotate(new Command("all"), { effects: LOCAL_READ, partial: true, output: { entity: "hit" } })
    .summary("search stored messages, notes, calendar events and selected meeting transcripts")
    .description(
      "search calendar events, messages from the other WireCat tools and notes in the local store, and a meeting " +
        "account's transcripts when --source names one — best match first; not mail (the separate memo CLI " +
        "searches it: memo search mail). Use it when you do not know where something was written; search events " +
        "reads the calendar with all its fields",
    )
    .argument("<query...>", 'strict Lucene query: words, "phrases", AND/OR/NOT, field groups and date ranges')
    .addHelpText("after", SAVE_HELP)
    .addHelpText("after", "--json: the list is items; each result's reference is ref, with its kind.")
  searches.addCommand(searchAllOptions(all))
  example(all, "search all roadmap", 'search all "quarterly review" --source telegram,gcal --json')
  all.action(async (words: string[], _opts: unknown, leaf: Command) => {
    const opts = leaf.opts<{
      only?: SourceSearched[]
      source?: string
      maxMeetings?: number | "all"
      limit?: number
      page?: number
      exact?: boolean
      timezone?: string
    }>()
    let lines = ""
    await within(
      leaf,
      async (run) => {
        if (run.locked && opts.source !== undefined)
          throw new CliError(
            "permission_error",
            "this process is locked to one profile; search all reads its own calendar only, without --source",
            { reason: "profile.locked" },
          )
        const denied = deniedKinds(leaf, app, opts.only ?? SOURCE_SEARCHED)
        const only = (opts.only ?? SOURCE_SEARCHED).filter((one) => !denied.some(({ kind }) => kind === one))
        if (!only.length)
          throw new CliError(
            "permission_error",
            `search all has nothing it may read: ${denied.map(({ why }) => why).join("; ")}`,
            { reason: "search.all-denied" },
          )
        const store = messagesOf(run, "search all")
        const limit = opts.limit ?? DEFAULT_LIMIT
        const offset = offsetOf(opts.page, limit)
        const env = run.env ?? process.env
        const found = await searchAllWithMeetings(
          store,
          run.account,
          {
            text: words.join(" "),
            limit,
            ...(offset === undefined ? {} : { offset }),
            ...(opts.exact ? { exact: true } : {}),
            timezone: opts.timezone ?? zone(),
            env,
            only,
            ...(opts.source === undefined ? {} : { source: opts.source }),
            ...(opts.maxMeetings === undefined ? {} : { maxMeetings: opts.maxMeetings }),
            ...(run.locked ? { scope: { events: [run.account] } } : {}),
          },
          { app },
          undefined,
          meaningLane({ env, messenger: { app }, store: async () => store }),
        )
        const note = (text: string) => outputFor(leaf).renderer.note(text)
        for (const { why } of denied) note(why)
        const globals = leaf.optsWithGlobals()
        if (!globals.json && !globals.jsonl)
          note(
            `searched: ${found.accounts.map(({ provider, account }) => `${provider}:${account}`).join(", ") || "nothing"}`,
          )
        for (const { resource, source, reason } of found.skipped) note(`${resource ?? source} not searched: ${reason}`)
        if (found.notes?.meaningSkipped) note(`notes by words only: ${found.notes.meaningSkipped}`)
        if (found.events?.meaningSkipped) note(`events by words only: ${found.events.meaningSkipped}`)
        const again = {
          query: words.join(" "),
          ...(opts.only === undefined ? {} : { only: opts.only.join(",") }),
          ...(opts.source === undefined ? {} : { source: opts.source }),
          ...(opts.maxMeetings === undefined ? {} : { max_meetings: opts.maxMeetings }),
          ...(opts.exact ? { exact: true } : {}),
          ...(opts.timezone === undefined ? {} : { timezone: opts.timezone }),
        }
        if (!found.items.length) note("nothing found in what the local store holds")
        const skips = await historySkipsOf(store, found.accounts).catch(() => [])
        lines = found.items.map(searchAllLine).join("")
        return allAnswer(
          "search all",
          found,
          { limit, page: opts.page ?? 1, again },
          opts.exact === true,
          skips,
          denied,
        ) as Body
      },
      () => lines,
    )
  })
}
