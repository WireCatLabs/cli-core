import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { savedSearch } from "../../entities/index.js"
import { isAdminSelection } from "../../services/admin-statistics.js"
import { readRankingSelection } from "../../services/rankings-selection.js"
import type { SearchParams } from "../../services/search-record.js"
import { savedSearchItem } from "../../services/searches.js"
import type { StoredSearch } from "../../store/store.js"
import { LOCAL_READ, LOCAL_WRITE, REMOTE_READ } from "../effects.js"
import { itemOf, listOf, renderAnswer } from "../envelope.js"
import { listQuery, pagedList, pageOf, typedQuery, unfilteredQuery, withQuery } from "../list-query.js"
import { positiveCount, withPaging } from "../paging.js"
import { type Messenger, messengerContext, refuseLocalWrite } from "./context.js"
import { wholeCount } from "./messages-search-command.js"
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

const SEARCHES_QUERY = unfilteredQuery("saved_search", savedSearch)

/** Saved searches and the history of `search messages` and `stats messages show`, in the local store only. */
export const searchesCommand = (messenger: Messenger): Command => {
  const searches = new Command("searches").description(
    "saved searches and the history of search messages and stats messages show, kept in the local store; --saved runs one",
  )

  annotate(searches.command("create"), { effects: LOCAL_WRITE, output: { entity: "saved_search" } })
    .description("save a search under a name without running it; search messages --saved <name> runs it")
    .argument("<name>", "up to 64 letters a–z, digits and hyphens, not only digits")
    .argument("[query...]", "the query, as for search messages; none matches every stored message")
    .option("--chat <chat>", `only this chat — the same as chat: in the query; ${messenger.chatArgument}`)
    .option(
      "--source <accounts>",
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
    .option("--timezone <zone>", "the IANA timezone for calendar date boundaries")
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
          }
        }
      }
      const saved = await context.withServices((services) =>
        services.searches.create(name, params, { replace: replace === true }),
      )
      renderAnswer(this, context, itemOf(savedSearchItem(saved)), () => `${line(saved)}\n`)
    })

  annotate(searches.command("show"), { effects: REMOTE_READ, output: { entity: "saved_search" } })
    .description("one saved search or earlier run: its query, options and how often it ran")
    .argument("<name|id>", "a saved search's name, or the id of any row of searches history")
    .action(async function (this: Command, reference: string) {
      const context = messengerContext(this, messenger)
      const found = await context.withServices((services) => services.searches.show(reference))
      renderAnswer(this, context, itemOf(savedSearchItem(found)), () => `${line(found)}\n`)
    })

  withQuery(annotate(searches.command("list"), { effects: LOCAL_READ }), SEARCHES_QUERY)
    .description("the saved searches, by name")
    .action(async function (this: Command, words: string[]) {
      const context = messengerContext(this, messenger)
      listQuery(typedQuery(words), SEARCHES_QUERY, "searches list")
      const found = await context.withServices((services) => services.searches.list())
      const items = found.map(savedSearchItem)
      renderAnswer(
        this,
        context,
        listOf("searches list", { items, limit: Math.max(1, items.length), has_more: false }),
        () => found.map((one) => `${line(one)}\n`).join(""),
      )
      if (found.length === 0 && context.format === "pretty")
        context.renderer.note("no saved searches — `searches create <name> <query>` saves one")
    })

  annotate(withPaging(annotate(searches.command("history"), { effects: LOCAL_READ })), {
    output: { entity: "saved_search" },
  })
    .description("the searches and counts that ran, newest first — saved ones included; never their results")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      const { limit, offset } = pageOf(context.settings)
      const found = await context.withServices((services) => services.searches.history(limit, offset))
      renderAnswer(
        this,
        context,
        pagedList("searches history", context.settings, {
          items: found.items.map(savedSearchItem),
          has_more: found.has_more,
        }),
        () => found.items.map((one) => `${line(one)}\n`).join(""),
      )
      if (found.items.length === 0 && context.format === "pretty") context.renderer.note("no searches ran yet")
    })

  annotate(searches.command("delete"), { effects: LOCAL_WRITE, output: { entity: "saved_search" } })
    .description("delete a saved search, or one run from the history")
    .argument("<name|id>", "a saved search's name, or the id of any row of searches history")
    .action(async function (this: Command, reference: string) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "searches.delete")
      const deleted = await context.withServices((services) => services.searches.delete(reference))
      renderAnswer(
        this,
        context,
        itemOf(savedSearchItem(deleted)),
        () => `deleted ${deleted.name ?? `run ${deleted.id}`}\n`,
      )
    })

  annotate(searches.command("clear"), { effects: LOCAL_WRITE })
    .description("empty the history; saved searches stay")
    .action(async function (this: Command) {
      const context = messengerContext(this, messenger)
      refuseLocalWrite(context, messenger.app.command, "searches.clear")
      const cleared = await context.withServices((services) => services.searches.clear())
      renderAnswer(this, context, itemOf(cleared), () => `${cleared.cleared} runs cleared\n`)
    })

  return searches
}
