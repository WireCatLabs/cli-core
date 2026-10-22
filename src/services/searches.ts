import { CliError, singleLine } from "@wirecat/cli-base"
import { parseLucene, type QueryAst } from "@wirecat/cli-base/query"
import type * as v from "valibot"
import type { savedSearch } from "../entities/saved-search.js"
import { validateAst, validateFields } from "../search/lucene/registry.js"
import { MESSAGE_PARSING } from "../search/lucene/types.js"
import type { MessageStore, StoredSearch } from "../store/store.js"
import { isAdminSelection, readAdminSelection } from "./admin-statistics.js"
import type { ServiceDeps } from "./deps.js"
import { type SearchParams, searchRecordOf } from "./search-record.js"

/** A saved search made ready to run, with the options the caller typed laid over the stored ones. */
export interface ResolvedSearch {
  id: string
  name: string | null
  params: SearchParams
}

export type SavedSearchItem = v.InferOutput<typeof savedSearch>

/** A saved search or a run as every searches command answers it. */
export const savedSearchItem = (one: StoredSearch): SavedSearchItem => ({
  id: one.id,
  name: one.name,
  command: one.command,
  params: one.params,
  language: one.language,
  version: one.version,
  fields_version: one.fieldsVersion,
  created_at: one.createdAt,
  last_run_at: one.lastRunAt,
  runs: one.runs,
})

export interface SearchesService {
  /** Saves without running (WC-CMD-6): the query is checked against today's fields first. */
  create(name: string, params: SearchParams, options?: { replace?: boolean }): Promise<StoredSearch>
  show(reference: string): Promise<StoredSearch>
  list(): Promise<StoredSearch[]>
  history(limit: number, offset?: number): Promise<{ items: StoredSearch[]; has_more: boolean }>
  delete(reference: string): Promise<StoredSearch>
  clear(): Promise<{ cleared: number }>
  /**
   * `--saved`: the stored query is parsed and checked again, so a field renamed since fails naming the
   * saved search; `words` are AND-ed to it, and every option in `typed` replaces the stored one.
   */
  resolve(reference: string, typed: SearchParams): Promise<ResolvedSearch>
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

const nameOf = (value: string): string => {
  const name = value.trim().toLowerCase()
  if (!NAME.test(name) || /^\d+$/.test(name))
    throw new CliError(
      "validation_error",
      `"${singleLine(value)}" cannot name a saved search — use up to 64 letters a–z, digits and hyphens, not only digits`,
      { reason: "name.invalid" },
    )
  return name
}

/** The query checked as a search would check it, without the store: syntax, fields, values. */
const checked = (params: SearchParams): SearchParams => {
  if (params.text !== undefined && params.ast !== undefined)
    throw new CliError("validation_error", "give query text or an AST, not both")
  if (params.ast !== undefined) validateAst(params.ast)
  else if (params.text !== undefined)
    validateFields(parseLucene(params.text, { ...MESSAGE_PARSING, defaultField: params.exact ? "exact" : "text" }))
  return params
}

const named = (search: StoredSearch, check: () => void) => {
  try {
    check()
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    const label = search.name === null ? `search run ${search.id}` : `saved search "${search.name}"`
    throw new CliError(error.code, `${label}: ${error.message}`, error.details)
  }
}

const both = (stored: QueryAst, words: string): QueryAst => ({
  version: 1,
  language: "lucene-v1",
  root: {
    kind: "boolean",
    clauses: [
      { occur: "must", node: stored.root },
      { occur: "must", node: parseLucene(words, MESSAGE_PARSING).root },
    ],
    span: { start: 0, end: 0 },
  },
})

export const searchesService = (deps: ServiceDeps): SearchesService => {
  const inStore = async <T>(work: (store: MessageStore) => Promise<T>): Promise<T> => work(await deps.store())
  const found = async (store: MessageStore, reference: string): Promise<StoredSearch> => {
    const search = await store.searches.storedSearch(reference.trim().toLowerCase())
    if (!search) throw new CliError("not_found", `no saved search or run "${singleLine(reference)}"`)
    return search
  }

  return {
    create: (name, params, { replace = false } = {}) =>
      inStore(async (store) => {
        if (isAdminSelection(params.selection)) {
          const selected = await readAdminSelection(store, params.selection)
          const normalized = typeof params.selection === "string" ? JSON.parse(params.selection) : params.selection
          return store.searches.saveSearch(
            nameOf(name),
            searchRecordOf("admin-statistics", {
              adminReport: selected.options.report,
              selection: normalized,
              timezone: selected.base.timezone,
            }),
            { replace },
          )
        }
        return store.searches.saveSearch(
          nameOf(name),
          searchRecordOf(
            params.target
              ? params.target === "messages"
                ? "message-top"
                : "author-top"
              : params.by === undefined
                ? "search"
                : "stats",
            checked(params),
          ),
          {
            replace,
          },
        )
      }),

    show: (reference) => inStore((store) => found(store, reference)),

    list: () => inStore((store) => store.searches.savedSearches()),

    history: (limit, offset = 0) =>
      inStore(async (store) => {
        const rows = await store.searches.searchHistory(limit, offset)
        return { items: rows.slice(0, limit), has_more: rows.length > limit }
      }),

    delete: (reference) => inStore(async (store) => store.searches.deleteSearch((await found(store, reference)).id)),

    clear: () => inStore(async (store) => ({ cleared: await store.searches.clearSearchHistory() })),

    resolve: (reference, { text: words, ...typed }) =>
      inStore(async (store) => {
        const search = await found(store, reference)
        const stored = search.params as SearchParams
        const inherited = { ...stored }
        if (stored.target !== undefined) {
          if (typed.measure !== undefined) {
            delete inherited.score
            delete inherited.weights
          }
          if (typed.score !== undefined || typed.weights !== undefined) delete inherited.measure
        }
        const params: SearchParams = {
          ...inherited,
          ...Object.fromEntries(Object.entries(typed).filter(([, one]) => one !== undefined)),
        }
        named(search, () => {
          // Rows written before the legacy search and --regex were removed: Lucene would read them differently.
          if (search.language !== "lucene-v1")
            throw new CliError("validation_error", "the legacy search and --regex are gone; save it again as Lucene")
          checked(stored)
        })
        const extra = words?.trim() ? words.trim() : undefined
        if (extra !== undefined) {
          if (params.ast !== undefined) params.ast = both(validateAst(params.ast), extra)
          else if (params.text === undefined) params.text = extra
          else params.text = `(${params.text}) AND (${extra})`
        }
        return { id: search.id, name: search.name, params }
      }),
  }
}
