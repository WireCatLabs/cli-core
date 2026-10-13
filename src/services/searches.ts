import { CliError, singleLine } from "@wirecat/cli-base"
import { parseLucene, type QueryAst } from "@wirecat/cli-base/query"
import type { AdminReport } from "../domain/admin-statistics.js"
import type { RankingInput, RankingTarget } from "../domain/rankings-options.js"
import { astJson, FIELD_VERSION, validateAst, validateFields } from "../search/lucene/registry.js"
import { QUERY_VERSION, SEARCH_QUERY } from "../search/lucene/types.js"
import type { MessageStore, SearchCommand, SearchRecord, StoredSearch } from "../store/store.js"
import { isAdminSelection, readAdminSelection } from "./admin-statistics.js"
import type { ServiceDeps } from "./deps.js"
import type { StatsGrouping } from "./messages-search.js"

/** What a run or a saved search keeps: the query and options as given, never a message or a result. */
export interface SearchParams extends RankingInput {
  discover?: boolean
  adminReport?: AdminReport
  selection?: unknown
  target?: RankingTarget
  text?: string
  ast?: unknown
  language?: "lucene" | "legacy"
  /** `text` is one JavaScript regular expression (legacy `--regex`). */
  regex?: boolean
  chat?: string
  source?: string
  timezone?: string
  limit?: number
  newest?: boolean
  /** Bare words and quotes match their exact form only (`--exact`). */
  exact?: boolean
  context?: number
  by?: StatsGrouping
}

/** A saved search made ready to run, with the options the caller typed laid over the stored ones. */
export interface ResolvedSearch {
  id: string
  name: string | null
  params: SearchParams
  pattern?: RegExp
}

export interface SearchesService {
  /** Saves without running (STANDARD rule 4): the query is checked against today's fields first. */
  create(name: string, params: SearchParams, options?: { replace?: boolean }): Promise<StoredSearch>
  show(reference: string): Promise<StoredSearch>
  list(): Promise<StoredSearch[]>
  history(limit: number): Promise<{ items: StoredSearch[]; hasMore: boolean }>
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

const canonical = (value: unknown, nested = false): unknown =>
  Array.isArray(value)
    ? value.map((one) => canonical(one, true))
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, one]) => one !== undefined && (nested || one !== false))
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, one]) => [key, canonical(one, true)]),
        )
      : value

/** One run or one saved search as the store keeps it; the same parameters always give the same text. */
export const searchRecordOf = (command: SearchCommand, params: SearchParams): SearchRecord => ({
  command,
  params: JSON.stringify(canonical({ ...params, language: languageOf(params) })),
  language: languageOf(params) === "lucene" ? "lucene-v1" : "legacy",
  version: QUERY_VERSION,
  fieldsVersion: FIELD_VERSION,
})

const languageOf = ({ language, regex, ast }: SearchParams): "lucene" | "legacy" =>
  language ?? (regex ? "legacy" : ast !== undefined ? "lucene" : "lucene")

const patternOf = (source: string): RegExp => {
  try {
    return new RegExp(source, "iu")
  } catch {
    throw new CliError("validation_error", "not a regular expression — check JavaScript syntax or use Lucene regex")
  }
}

/** The query checked as a search would check it, without the store: syntax, fields, values. */
const checked = (params: SearchParams): SearchParams => {
  if (params.discover && (params.regex || languageOf(params) === "legacy"))
    throw new CliError("validation_error", "discovery requires Lucene text, without legacy or regex")
  if (params.text !== undefined && params.ast !== undefined)
    throw new CliError("validation_error", "give query text or an AST, not both")
  if (params.regex) {
    if (params.text === undefined) throw new CliError("validation_error", "--regex needs the expression")
    patternOf(params.text)
  } else if (languageOf(params) === "lucene") {
    if (params.ast !== undefined) validateAst(params.ast)
    else if (params.text !== undefined)
      validateFields(parseLucene(params.text, { ...SEARCH_QUERY, defaultField: params.exact ? "exact" : "text" }))
  }
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
      { occur: "must", node: parseLucene(words, SEARCH_QUERY).root },
    ],
    span: { start: 0, end: 0 },
  },
})

export const searchesService = (deps: ServiceDeps): SearchesService => {
  const inStore = async <T>(work: (store: MessageStore) => Promise<T>): Promise<T> => work(await deps.store())
  const found = async (store: MessageStore, reference: string): Promise<StoredSearch> => {
    const search = await store.storedSearch(reference.trim().toLowerCase())
    if (!search) throw new CliError("not_found", `no saved search or run "${singleLine(reference)}"`)
    return search
  }

  return {
    create: (name, params, { replace = false } = {}) =>
      inStore(async (store) => {
        if (isAdminSelection(params.selection)) {
          const selected = await readAdminSelection(store, params.selection)
          const normalized = typeof params.selection === "string" ? JSON.parse(params.selection) : params.selection
          return store.saveSearch(
            nameOf(name),
            searchRecordOf("admin-statistics", {
              adminReport: selected.options.report,
              selection: normalized,
              language: "lucene",
              timezone: selected.base.timezone,
            }),
            { replace },
          )
        }
        return store.saveSearch(
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

    list: () => inStore((store) => store.savedSearches()),

    history: (limit) =>
      inStore(async (store) => {
        const rows = await store.searchHistory(limit)
        return { items: rows.slice(0, limit), hasMore: rows.length > limit }
      }),

    delete: (reference) => inStore(async (store) => store.deleteSearch((await found(store, reference)).id)),

    clear: () => inStore(async (store) => ({ cleared: await store.clearSearchHistory() })),

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
        const language = languageOf(params)
        if (language === "lucene" && !params.regex) named(search, () => checked({ ...stored, language }))
        const extra = words?.trim() ? words.trim() : undefined
        if (extra !== undefined) {
          if (params.regex)
            throw new CliError(
              "validation_error",
              `saved search "${search.name}" is a --regex search; it takes no more words`,
            )
          if (params.ast !== undefined) params.ast = astJson(both(validateAst(params.ast), extra))
          else if (params.text === undefined) params.text = extra
          else params.text = language === "lucene" ? `(${params.text}) AND (${extra})` : `${params.text} ${extra}`
        }
        return {
          id: search.id,
          name: search.name,
          params,
          ...(params.regex && params.text !== undefined ? { pattern: patternOf(params.text) } : {}),
        }
      }),
  }
}
