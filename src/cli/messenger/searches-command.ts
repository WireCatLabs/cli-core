import { CliError } from "@wirecat/cli-base"
import { Command } from "commander"
import { isAdminSelection } from "../../services/admin-statistics.js"
import { readRankingSelection } from "../../services/rankings-selection.js"
import type { SearchParams } from "../../services/searches.js"
import type { StoredSearch } from "../../store/store.js"
import { listed, positiveCount } from "../paging.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"
import { languageOf, wholeCount } from "./messages-search-command.js"
import { groupingOf } from "./messages-stats-command.js"

const line = ({ id, name, command, params, runs, lastRunAt }: StoredSearch) =>
  [
    id.padStart(5),
    name ?? "-",
    command,
    JSON.stringify(params.text ?? params.ast ?? ""),
    `${runs} runs`,
    lastRunAt?.slice(0, 16).replace("T", " ") ?? "never run",
  ].join("  ")

/** Saved searches and the history of `search messages` and `stats messages show`, in the local store only. */
export const searchesCommand = (messenger: Messenger): Command => {
  const searches = new Command("searches").description(
    "saved searches and the history of search messages and stats messages show, kept in the local store; --saved runs one",
  )

  searches
    .command("create")
    .description("save a search under a name without running it; search messages --saved <name> runs it")
    .argument("<name>", "up to 64 letters a–z, digits and hyphens, not only digits")
    .argument("[query...]", "the query, as for search messages; none matches every stored message")
    .option("--chat <chat>", `only this chat — the same as chat: in the query; ${messenger.chatArgument}`)
    .option(
      "--source <messenger>",
      "every account of this messenger held in the store; personal, bots or all — the same as in: in the query; " +
        "or a list: group:work,telegram:Alice,email:me@example.com",
    )
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .option("--newest", "newest first instead of best first")
    .option(
      "--exact",
      "bare words and quotes match their exact form only, as exact:word does; text: still matches every form",
    )
    .option("--context <n>", "messages before and after each hit", wholeCount)
    .option("--language <lucene|legacy>", "the query language: strict Lucene or legacy discovery", languageOf)
    .option("--timezone <zone>", "the IANA timezone for calendar date boundaries")
    .option("--regex", "the words are one regular expression, case-insensitive, tested against every stored text")
    .option("--by <chat|sender|day|hour>", "what stats messages show --saved counts by", groupingOf)
    .option("--selection <json>", "save the resolved parent ranking query and options from a drilldown")
    .option("--replace", "overwrite a saved search of the same name")
    .action(async function (this: Command, name: string, words: string[]) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "searches.create")
      const { replace, ...options } = this.opts<Omit<SearchParams, "text" | "ast"> & { replace?: boolean }>()
      let params: SearchParams = {
        ...Object.fromEntries(Object.entries(options).filter(([, one]) => one !== undefined)),
        ...(words.length ? { text: words.join(" ") } : {}),
      }
      if (params.selection !== undefined) {
        if (words.length || Object.entries(options).some(([key, value]) => key !== "selection" && value !== undefined))
          throw new CliError(
            "validation_error",
            "with --selection, save the resolved ranking query without additional search options",
          )
        if (!isAdminSelection(params.selection)) {
          const selection = await context.withStore((store) => readRankingSelection(store, params.selection))
          params = {
            selection,
            target: selection.target,
            ...selection.options,
            timezone: selection.timezone,
            language: "lucene",
          }
        }
      }
      const saved = await context.withServices((services) =>
        services.searches.create(name, params, { replace: replace === true }),
      )
      if (context.format !== "pretty") context.renderer.result(saved)
      else context.streams.data(`${line(saved)}\n`)
    })

  searches
    .command("show")
    .description("one saved search or earlier run: its query, options and how often it ran")
    .argument("<name|id>", "a saved search's name, or the id of any row of searches history")
    .action(async function (this: Command, reference: string) {
      const context = messengerContext(this, messenger)
      context.renderer.result(await context.withServices((services) => services.searches.show(reference)))
    })

  searches
    .command("list")
    .description("the saved searches, by name")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) => services.searches.list())
      if (context.format === "jsonl") context.renderer.stream(found)
      else if (context.format !== "pretty") context.renderer.result(listed(found))
      else if (found.length === 0)
        context.renderer.note("no saved searches — `searches create <name> <query>` saves one")
      else context.streams.data(`${found.map(line).join("\n")}\n`)
    })

  searches
    .command("history")
    .description("the searches and counts that ran, newest first — saved ones included; never their results")
    .option("--limit <n>", "how many", positiveCount("--limit"))
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const { limit } = context.settings
      const found = await context.withServices((services) => services.searches.history(limit))
      if (context.format === "jsonl") context.renderer.stream(found.items)
      else if (context.format !== "pretty") context.renderer.result({ ...found, page: 1, limit })
      else {
        if (found.items.length > 0) context.streams.data(`${found.items.map(line).join("\n")}\n`)
        else context.renderer.note("no searches ran yet")
        if (found.hasMore) context.renderer.note(`more — \`searches history --limit ${limit * 2}\``)
      }
    })

  searches
    .command("delete")
    .description("delete a saved search, or one run from the history")
    .argument("<name|id>", "a saved search's name, or the id of any row of searches history")
    .action(async function (this: Command, reference: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "searches.delete")
      const deleted = await context.withServices((services) => services.searches.delete(reference))
      if (context.format !== "pretty") context.renderer.result(deleted)
      else context.streams.data(`deleted ${deleted.name ?? `run ${deleted.id}`}\n`)
    })

  searches
    .command("clear")
    .description("empty the history; saved searches stay")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "searches.clear")
      const cleared = await context.withServices((services) => services.searches.clear())
      if (context.format !== "pretty") context.renderer.result(cleared)
      else context.streams.data(`${cleared.cleared} runs cleared\n`)
    })

  return searches
}
