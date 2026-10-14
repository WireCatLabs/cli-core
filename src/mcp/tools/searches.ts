import { CliError } from "@wirecat/cli-base"
import * as v from "valibot"
import { itemOf, listOf } from "../../cli/envelope.js"
import type { Messenger } from "../../cli/messenger/context.js"
import type { SendGuard } from "../../sends/guard.js"
import { isAdminSelection } from "../../services/admin-statistics.js"
import { servicesFor, storedDeps } from "../../services/index.js"
import { readRankingSelection } from "../../services/rankings-selection.js"
import { savedSearchItem } from "../../services/searches.js"
import type { AccountKey, MessageStore } from "../../store/store.js"
import { type AnyTool, chatOf, limit, page, paging, READ, tool } from "../tool.js"

const LOCAL = { readOnlyHint: false, openWorldHint: false }
const reference = v.pipe(
  v.string(),
  v.minLength(1),
  v.description("a saved search's name, or the id of any row of searches_history"),
)

export const searchesTools = (messenger: Messenger): Record<string, AnyTool> => {
  const services = (store: MessageStore, account: AccountKey, guard: SendGuard) =>
    servicesFor(storedDeps(messenger, store, account, guard))
  return {
    searches_list: tool({
      title: "List saved searches",
      description: "The saved searches, by name; search_messages and stats_messages_show run one with `saved`.",
      input: v.object({}),
      annotations: { ...READ, openWorldHint: false },
      output: { entity: "saved_search", list: true },
      stored: async (store, account, _args, defaults) => {
        const items = (await services(store, account, defaults.guard).searches.list()).map(savedSearchItem)
        return listOf("searches list", { items, limit: Math.max(1, items.length), has_more: false })
      },
    }),

    searches_history: tool({
      title: "Search history",
      description:
        "The searches and counts that ran, newest first, saved ones included: the query and options as given, " +
        "never the results. `saved` with an id runs one again.",
      input: v.object({ limit, page }),
      annotations: { ...READ, openWorldHint: false },
      output: { entity: "saved_search", list: true },
      stored: async (store, account, args, defaults) => {
        const { size, number, window } = paging(args, defaults)
        const found = await services(store, account, defaults.guard).searches.history(window.limit, window.offset)
        return listOf("searches history", {
          items: found.items.map(savedSearchItem),
          limit: size,
          has_more: found.has_more,
          page: number,
        })
      },
    }),

    searches_create: tool({
      title: "Save a search",
      description:
        "Saves a search under a name without running it; the query is checked against today's fields. Takes " +
        "search_messages's arguments, plus `by` for stats_messages_show. A taken name is refused unless `replace`. " +
        "Writes only to the local store.",
      input: v.object({
        name: v.pipe(v.string(), v.minLength(1), v.description("up to 64 letters a–z, digits and hyphens")),
        text: v.optional(v.pipe(v.string(), v.minLength(1), v.description("the query: Lucene text or legacy syntax"))),
        ast: v.optional(v.unknown()),
        language: v.optional(v.picklist(["lucene", "legacy"])),
        timezone: v.optional(v.string()),
        chat: v.optional(chatOf(messenger)),
        source: v.optional(v.pipe(v.string(), v.minLength(1), v.description("a messenger held on this machine"))),
        newest: v.optional(v.boolean()),
        context: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(20))),
        limit,
        by: v.optional(v.picklist(["chat", "sender", "day", "hour"])),
        selection: v.optional(v.union([v.string(), v.record(v.string(), v.unknown())])),
        replace: v.optional(v.pipe(v.boolean(), v.description("overwrite a saved search of the same name"))),
      }),
      annotations: { ...LOCAL, destructiveHint: false, idempotentHint: false },
      output: { entity: "saved_search", list: false },
      stored: async (store, account, { name, replace, ...params }, defaults) => {
        if (params.selection !== undefined) {
          if (Object.entries(params).some(([key, value]) => key !== "selection" && value !== undefined))
            throw new CliError(
              "validation_error",
              "with selection, save the resolved ranking query without additional options",
            )
          if (isAdminSelection(params.selection))
            return itemOf(
              savedSearchItem(
                await services(store, account, defaults.guard).searches.create(name, params, {
                  replace: replace === true,
                }),
              ),
            )
          const selection = await readRankingSelection(store, params.selection)
          const saved = await services(store, account, defaults.guard).searches.create(
            name,
            {
              selection,
              target: selection.target,
              ...selection.options,
              timezone: selection.timezone,
              language: "lucene",
            },
            { replace: replace === true },
          )
          return itemOf(savedSearchItem(saved))
        }
        return itemOf(
          savedSearchItem(
            await services(store, account, defaults.guard).searches.create(name, params, { replace: replace === true }),
          ),
        )
      },
    }),

    searches_delete: tool({
      title: "Delete a saved search",
      description: "Deletes a saved search, or one run from the history. Writes only to the local store.",
      input: v.object({ name: reference }),
      annotations: { ...LOCAL, destructiveHint: true, idempotentHint: false },
      output: { entity: "saved_search", list: false },
      stored: async (store, account, args, defaults) => {
        return itemOf(savedSearchItem(await services(store, account, defaults.guard).searches.delete(args.name)))
      },
    }),

    searches_clear: tool({
      title: "Clear search history",
      description:
        "Empties the search history; saved searches stay. Writes only to the local store. Returns { item: { cleared } }.",
      input: v.object({}),
      annotations: { ...LOCAL, destructiveHint: true, idempotentHint: true },
      stored: async (store, account, _args, defaults) => {
        return itemOf(await services(store, account, defaults.guard).searches.clear())
      },
    }),
  }
}
