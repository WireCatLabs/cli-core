import { CliError, isCliError } from "@wirecat/cli-base"
import { dateRange, parseLucene, type QueryNode, timezoneOf } from "@wirecat/cli-base/query"
import { INTERNAL_NOTES } from "../domain/providers.js"
import { normalizeTag } from "../domain/tags.js"
import {
  defaultThreads,
  type Embedder,
  isTextModelInstalled,
  openEmbedder,
  textModelsDirectory,
  type WarmEmbedders,
} from "../embeddings/embed.js"
import { DEFAULT_TEXT_MODEL, meaningFloor, type TextModel, textModel, vectorModelKey } from "../embeddings/models.js"
import type { PictureEmbedder } from "../images/picture/embedder.js"
import { DEFAULT_IMAGE_MODEL, imageModel } from "../images/picture/models.js"
import type { AppIdentity } from "../ports/app.js"
import { entriesOfList, fitting, type SkippedSource } from "../search/account-list.js"
import { validateFields } from "../search/lucene/registry.js"
import { hasStems, type ResolvedNode } from "../search/lucene/resolved.js"
import { SEARCH_QUERY } from "../search/lucene/types.js"
import { createStemmer, DEFAULT_STEMMERS, type Stemmer } from "../search/stem.js"
import { type SearchTotal, TOTAL_CAP, totalOf } from "../search/total.js"
import type { Link, NearestNote, Note, NoteHit } from "../store/index.js"
import type { AccountKey, MessageStore } from "../store/store.js"
import { openPictureEmbedderFor } from "./document-pictures.js"
import { documentSource } from "./document-source.js"
import { plainQueryWords, titleQuery, titleTiers } from "./notes-title-tier.js"
import { PICTURE_FLOOR, plainWords } from "./pictures.js"
import { listContextOf } from "./search-kind.js"

export interface NotesSearchRequest {
  text: string
  limit: number
  offset?: number
  /** Every word as written: no stems. */
  exact?: boolean
  newest?: boolean
  /** Every folder when unset: a notes folder is a place the owner keeps notes, not someone else's account. */
  folderIds?: string[]
  withInternal?: boolean
  source?: Note["source"]
  /** For `date:` — the zone a bare day is read in. */
  timezone?: string
  signal?: AbortSignal
}

/**
 * Text in the query language messages use, parsed for a store search: `date:` read in `timezone`, and the store's
 * stemmer when a word is stemmed.
 */
export const storeQuery = async (
  store: MessageStore,
  text: string,
  { exact, timezone }: { exact?: boolean; timezone?: string } = {},
): Promise<{ root: ResolvedNode; stemmer?: Stemmer }> => resolvedQuery(store, parsedQuery(text, exact), timezone)

const parsedQuery = (text: string, exact?: boolean): QueryNode =>
  validateFields(parseLucene(text, { ...SEARCH_QUERY, defaultField: exact ? "exact" : "text" })).root

const resolvedQuery = async (
  store: MessageStore,
  root: QueryNode,
  timezone: string | undefined,
): Promise<{ root: ResolvedNode; stemmer?: Stemmer }> => {
  const ast = { root }
  const zone = timezoneOf(timezone)
  const resolve = (node: QueryNode): ResolvedNode => {
    if (node.kind === "boolean")
      return { ...node, clauses: node.clauses.map(({ occur, node }) => ({ occur, node: resolve(node) })) }
    if (node.field !== "date") return node
    return {
      ...node,
      resolution: {
        date: dateRange(
          node.value,
          node.operator === "range" ? (node.upper ?? "*") : node.value,
          node.operator === "range" ? node.lower_inclusive === true : true,
          node.operator === "range" ? node.upper_inclusive === true : true,
          zone,
          node.span,
        ),
      },
    }
  }
  const stemmers = hasStems(ast.root) ? await store.searchIndex.stemmers() : undefined
  if (stemmers === null)
    throw new CliError(
      "validation_error",
      "the store asks for stemmers this tool does not know — upgrade this tool, or search exact forms with --exact",
      { reason: "stemmer.unknown" },
    )
  return {
    root: resolve(ast.root),
    ...(hasStems(ast.root) ? { stemmer: createStemmer(stemmers ?? DEFAULT_STEMMERS) } : {}),
  }
}

/** A notes search in the query language messages use, for `search notes` and `search all` to call. */
export const searchNotesQuery = async (
  store: MessageStore,
  request: NotesSearchRequest,
): Promise<{ items: NoteHit[]; hasMore: boolean }> => {
  if (!request.text.trim()) throw new CliError("validation_error", "say what to find in the notes")
  const { root, stemmer } = await storeQuery(store, request.text, request)
  return store.notes.search({
    root,
    limit: request.limit,
    ...(request.offset === undefined ? {} : { offset: request.offset }),
    ...(request.newest ? { newest: true } : {}),
    ...(request.folderIds ? { folderIds: request.folderIds } : {}),
    ...(request.withInternal ? { withInternal: true } : {}),
    ...(request.source ? { source: request.source } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
    ...(stemmer ? { stemmer } : {}),
  })
}

export interface NotesEmbedOptions {
  /** A local text model by id; e5-small, as conversations use, when absent. */
  model?: string
  /** How many chunks this run embeds at most; the next run continues. */
  maxChunks?: number
  env?: NodeJS.ProcessEnv
  threads?: number
}

export interface NotesEmbedded {
  model: string
  embedded: number
  /** Chunks still without a vector, when `maxChunks` stopped the run. */
  left: boolean
}

/** Chunks one batch embeds: one short transaction writes each, as for conversations. */
const NOTE_BATCH = 8

/** `command` is given only by a tool that has `models download`; any other gets the tools that do. */
const downloadHint = (model: string, command: string | undefined) =>
  command === undefined
    ? `install it with a WireCat CLI that has \`models download\` (tg, max or wa); they share the model folder`
    : `\`${command} models download ${model}\``

export const localModel = (
  choice: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
  command: string | undefined,
) => {
  const model = textModel(choice ?? DEFAULT_TEXT_MODEL)
  const directory = textModelsDirectory(env)
  if (!isTextModelInstalled(model, directory))
    throw new CliError("not_found", `${model.id} is not downloaded — ${downloadHint(model.id, command)}`, {
      reason: "model.not-downloaded",
      model: model.id,
    })
  return { model, directory, key: vectorModelKey(model) }
}

export const withLocal = async <T>(
  model: TextModel,
  directory: string,
  threads: number | undefined,
  work: (embedder: Embedder) => Promise<T>,
  shared?: Pick<WarmEmbedders, "get">,
): Promise<T> => {
  if (shared)
    return work(
      await shared.get(vectorModelKey(model), () =>
        openEmbedder(model, directory, { threads: threads ?? defaultThreads() }),
      ),
    )
  const embedder = await openEmbedder(model, directory, { threads: threads ?? defaultThreads() })
  try {
    return await work(embedder)
  } finally {
    await embedder.close()
  }
}

/**
 * Embeds the notes' chunks that have no vector of the model yet, with the same model, prefixes and key
 * as conversations, so a chunk whose text a conversation shares is embedded once. A missing model is
 * an error naming the download command; nothing is downloaded.
 */
const embedChunks = async (
  store: MessageStore,
  source: Pick<MessageStore["notes"] | MessageStore["calendar"], "chunksToEmbed">,
  {
    model: choice,
    maxChunks = Number.POSITIVE_INFINITY,
    env,
    threads,
    command,
  }: NotesEmbedOptions & {
    command?: string
  } = {},
): Promise<NotesEmbedded> => {
  const { model, directory, key } = localModel(choice, env, command)
  if ((await source.chunksToEmbed(key, { limit: 1 })).length === 0) return { model: model.id, embedded: 0, left: false }
  return withLocal(model, directory, threads, async (embedder) => {
    let embedded = 0
    let after: string | undefined
    while (embedded < maxChunks) {
      const batch = await source.chunksToEmbed(key, {
        limit: Math.min(NOTE_BATCH, maxChunks - embedded),
        ...(after === undefined ? {} : { after }),
      })
      if (batch.length === 0) break
      after = batch.at(-1)?.hash
      const vectors = await embedder.embed(
        batch.map(({ text }) => text),
        "passage",
      )
      await store.vectors.saveVectors(
        key,
        model.dims,
        batch.map(({ hash }, index) => ({ hash, vector: vectors[index] as Float32Array })),
      )
      embedded += batch.length
    }
    const left = (await source.chunksToEmbed(key, { limit: 1, ...(after === undefined ? {} : { after }) })).length > 0
    return { model: model.id, embedded, left }
  })
}

export const embedNotes = (store: MessageStore, options: NotesEmbedOptions & { command?: string } = {}) =>
  embedChunks(store, store.notes, options)

/** Embeds calendar events' pieces as notes' are embedded; the occurrences of a series share one vector. */
export const embedEvents = (store: MessageStore, options: NotesEmbedOptions & { command?: string } = {}) =>
  embedChunks(store, store.calendar, options)

/** Embeds mail's chunks as notes' are embedded: same model and key, so search by meaning reads both. */
export const embedMail = (store: MessageStore, options: NotesEmbedOptions & { command?: string } = {}) =>
  embedChunks(store, store.mail, options)

/** Notes nearest in meaning to the query, best first; only notes already embedded can be found. */
export const nearestNotes = async (
  store: MessageStore,
  query: string,
  options: NearestOptions,
): Promise<NearestNote[]> => {
  const { key, vector, floor } = await queryVector(store, query, options)
  const nearest = await store.notes.nearest(key, vector, {
    limit: options.limit,
    ...(options.folderIds ? { folderIds: options.folderIds } : {}),
    ...(options.withInternal ? { withInternal: true } : {}),
    ...(options.source ? { source: options.source } : {}),
  })
  return nearest.filter(({ score }) => score > floor)
}

type NearestOptions = Omit<NotesEmbedOptions, "maxChunks"> & {
  limit: number
  folderIds?: string[]
  withInternal?: boolean
  source?: Note["source"]
  command?: string
  /** The search's own, when another part of it loads the same model. */
  embedders?: Pick<WarmEmbedders, "get">
}

const queryVector = async (
  store: MessageStore,
  query: string,
  { model: choice, folderIds, withInternal, source, env, threads, command, embedders }: Omit<NearestOptions, "limit">,
): Promise<{ key: string; vector: Float32Array; floor: number }> => {
  if (!query.trim()) throw new CliError("validation_error", "say what to find in the notes")
  const { model, directory, key } = localModel(choice, env, command)
  const scope = {
    ...(folderIds ? { folderIds } : {}),
    ...(withInternal ? { withInternal: true } : {}),
    ...(source ? { source } : {}),
  }
  if (!(await store.notes.embedded(key, scope)))
    throw new CliError("not_found", `nothing searched here has vectors of ${model.id} yet, so only words were matched`)
  const [vector] = await withLocal(model, directory, threads, (embedder) => embedder.embed([query], "query"), embedders)
  return { key, vector: vector as Float32Array, floor: meaningFloor(key) }
}

/** Every note of `refs` nearer in meaning than the model's floor, best first. */
const nearestAmong = async (
  store: MessageStore,
  query: string,
  refs: string[],
  options: Omit<NearestOptions, "limit">,
): Promise<{ ref: string; score: number }[]> => {
  const { key, vector, floor } = await queryVector(store, query, options)
  return (await store.notes.scoreNotes(key, vector, refs)).filter(({ score }) => score > floor)
}

export interface FoundNote {
  kind?: "document" | "note"
  provider?: string
  account?: string
  url?: string
  ref: string
  source: Note["source"]
  folder_id: string | null
  /** The note's path inside its folder; `null` for a note written in memo. */
  path: string | null
  title: string | null
  /** The time `date:` reads: a Drive document's edit time when the store has one, else when the store's copy changed. */
  updated_at: string
  /** The first line holding a word of the query. */
  excerpt: string
  links: { to: Link["to"]; target_text: Link["targetText"]; kind: Link["kind"]; anchor: Link["anchor"] }[]
  /** Which halves of the search found it. */
  found_by: ("title" | "words" | "meaning")[]
}

export interface LinkedRecord {
  /** `person:…`, `note:…`, `entity:…`, or `null` while the name written in the notes matches nobody yet. */
  ref: string | null
  name: string | null
  /** How many of the notes found link it. */
  notes: number
}

export interface NotesFound {
  query: string
  tag?: string
  filter?: string
  /** Words and word stems always; meaning too when the model is there and the query is not exact. */
  by: "words" | "words and meaning"
  /** Why meaning was not searched, when it was not. */
  meaning_skipped?: string
  hits: FoundNote[]
  /** How many notes match the query, every page together, as Elasticsearch's `hits.total`. */
  total?: SearchTotal
  has_more: boolean
  next_offset?: number
  /** What the notes found link to, most linked first. */
  linked: LinkedRecord[]
  /** Documents whose picture is nearest the words, best first; only when `pictures` was asked for. Never in `hits`. */
  pictures?: { ref: string; score: number }[]
  /** Why pictures were asked for and none were searched. */
  pictures_skipped?: string
}

export interface NotesQuery {
  limit?: number
  offset?: number
  tag?: string
  /** A query in the same language that every hit must also match, as the query's own fields are. */
  filter?: string
  folderIds?: string[]
  /** With `folderIds`, the notes written in memo too: one ranked list, so `offset` pages it. */
  withInternal?: boolean
  source?: Note["source"]
  exact?: boolean
  timezone?: string
  env?: NodeJS.ProcessEnv
  /** The tool's command, named in the hint when the model is missing. */
  command?: string
  /** The search's own models, when another part of it loads the same one. */
  embedders?: Pick<WarmEmbedders, "get">
  /** Adds `pictures`, the documents whose picture the plain words describe, beside the hits. English words. */
  pictures?: boolean
  pictureLimit?: number
  /** An open picture embedder, for tests and callers that keep one; opened and closed here when absent. */
  pictureEmbedder?: PictureEmbedder
}

type Held = { note: Note; at: string; score: number; foundBy: ("title" | "words" | "meaning")[] }

const MAX_LINE = 200
const MAX_NOTES_OFFSET = 1000
/** How deep each half is read before the two are merged. */
const CANDIDATES = 50
/** Reciprocal rank fusion's usual constant, as conversations use. */
export const RRF_K = 60

const firstLine = (text: string, query: string): string => {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((word) => word.length > 2 && !["and", "or", "not"].includes(word))
  const lines = text.split("\n")
  const found = lines.find((line) => words.some((word) => line.toLowerCase().includes(word)))
  return (found ?? lines.find((line) => line.trim() !== "") ?? "").trim().slice(0, MAX_LINE)
}

/** The documents nearest to what the words describe by their picture. A missing model is a note, not a failure. */
const pictureLane = async (
  store: MessageStore,
  query: string,
  {
    folderIds,
    source,
    limit,
    env,
    command,
    embedder,
  }: {
    folderIds: string[] | undefined
    source: Note["source"] | undefined
    limit: number
    env: NodeJS.ProcessEnv | undefined
    command: string | undefined
    embedder: PictureEmbedder | undefined
  },
): Promise<Pick<NotesFound, "pictures" | "pictures_skipped">> => {
  const words = plainWords(query)
  if (words === "" || source === "internal") return {}
  let vector: Float32Array
  try {
    const use =
      embedder ??
      (await openPictureEmbedderFor({
        ...(env === undefined ? {} : { env }),
        ...(command === undefined ? {} : { command }),
      }))
    try {
      vector = await use.embedQuery(words)
    } finally {
      if (!embedder) await use.close()
    }
  } catch (error) {
    if (error instanceof CliError && error.code === "not_found") return { pictures_skipped: error.message }
    throw error
  }
  const near = await store.notes.nearestPictures(imageModel(DEFAULT_IMAGE_MODEL).key, vector, {
    limit,
    ...(folderIds === undefined ? {} : { folderIds }),
  })
  return {
    pictures: near
      .filter(({ score }) => score >= PICTURE_FLOOR)
      .map(({ ref, score }) => ({ ref, score: Number(score.toFixed(4)) })),
  }
}

/**
 * A `source:` every hit must match, and the query without it. The meaning half and the picture lane cannot read a
 * field, so they get the source and the rest of the words; the words half still compiles the field itself.
 */
export const noteSourceOfQuery = (query: string): { source?: Note["source"]; rest: string } => {
  let root: QueryNode
  try {
    root = parseLucene(query, { ...SEARCH_QUERY, defaultField: "text" }).root
  } catch {
    return { rest: query }
  }
  const required =
    root.kind === "predicate"
      ? [root]
      : root.clauses.flatMap(({ occur, node }) => (occur === "must" && node.kind === "predicate" ? [node] : []))
  const typed = required.find(
    ({ field, operator }) => field === "source" && (operator === "term" || operator === "phrase"),
  )
  const source = typed?.value.toLowerCase()
  if (typed === undefined || (source !== "internal" && source !== "file")) return { rest: query }
  const rest = `${query.slice(0, typed.span.start).replace(/\s*(?:AND|&&)\s*$/u, "")} ${query
    .slice(typed.span.end)
    .replace(/^\s*(?:AND|&&)\s*/u, "")}`.trim()
  try {
    if (rest) parseLucene(rest, { ...SEARCH_QUERY, defaultField: "text" })
  } catch {
    return { source, rest: query }
  }
  return { source, rest }
}

const WORD_FIELDS = new Set(["text", "exact"])

/**
 * What a note found by meaning must still match: the query with each word it asks for taken as matched, since the
 * meaning half stands in for those. Words it excludes, and every other field, stay. `undefined` when nothing but
 * wanted words is left, so any note found by meaning fits.
 */
export const fieldsOfQuery = (root: QueryNode): QueryNode | undefined => {
  let narrows = false
  const kept = (node: QueryNode): QueryNode => {
    if (node.kind === "boolean")
      return {
        ...node,
        clauses: node.clauses.map(({ occur, node }) => {
          if (occur !== "must_not") return { occur, node: kept(node) }
          narrows = true
          return { occur, node }
        }),
      }
    if (!WORD_FIELDS.has(node.field)) {
      narrows = true
      return node
    }
    // `in:notes` holds for every note and document; an empty clause list would match nothing.
    return { kind: "predicate", field: "in", operator: "term", value: "notes", span: node.span }
  }
  const fields = kept(root)
  return narrows ? fields : undefined
}

/** The words and phrases the query asks for, for the meaning half to embed; none it excludes, no field. */
export const meaningWords = (root: QueryNode): string => {
  const wanted = (node: QueryNode): string[] =>
    node.kind === "boolean"
      ? node.clauses.flatMap(({ occur, node }) => (occur === "must_not" ? [] : wanted(node)))
      : WORD_FIELDS.has(node.field) && (node.operator === "term" || node.operator === "phrase")
        ? [node.value]
        : []
  return wanted(root).join(" ").trim()
}

const allOf = (nodes: QueryNode[]): QueryNode | undefined =>
  nodes.length <= 1
    ? nodes[0]
    : {
        kind: "boolean",
        clauses: nodes.map((node) => ({ occur: "must" as const, node })),
        span: { start: 0, end: 0 },
      }

/**
 * The notes of `refs` that match `root`, in the order of `refs`, each with the time `date:` read. One store query over
 * just those notes, so a filter that matches thousands of notes still checks every candidate.
 */
const matching = async (
  store: MessageStore,
  refs: string[],
  root: QueryNode | undefined,
  scope: Pick<NotesSearchRequest, "folderIds" | "withInternal" | "source" | "timezone">,
): Promise<Map<string, { note: Note; at: string }>> => {
  if (refs.length === 0) return new Map()
  const resolved = await resolvedQuery(
    store,
    root ?? { kind: "predicate", field: "in", operator: "term", value: "notes", span: { start: 0, end: 0 } },
    scope.timezone,
  )
  const found = await store.notes.search({
    root: resolved.root,
    refs,
    limit: refs.length,
    ...(scope.folderIds ? { folderIds: scope.folderIds } : {}),
    ...(scope.withInternal ? { withInternal: true } : {}),
    ...(scope.source ? { source: scope.source } : {}),
    ...(resolved.stemmer ? { stemmer: resolved.stemmer } : {}),
  })
  return new Map(found.items.map(({ ref, note, at }) => [ref, { note, at }]))
}

/**
 * The most notes a filter may hold for meaning to rank all of them, each by its best chunk. Above it, meaning ranks
 * the nearest notes overall and keeps those inside the filter, so a narrow filter over a large store loses some. On
 * the owner's store (1,454 documents, 23,308 chunks) scoring all of them took ~0.5 s against ~0.17 s for the
 * nearest 50 overall, and the cost grows with chunks, so 2,000 notes keeps it under a second at that density.
 */
export const RANK_WITHIN = 2000

/** The notes of a filter, newest first, when there are at most `RANK_WITHIN`; `undefined` when more, or too costly. */
const filterRefs = async (
  store: MessageStore,
  narrowing: QueryNode,
  scope: Pick<NotesSearchRequest, "folderIds" | "withInternal" | "source" | "timezone">,
): Promise<string[] | undefined> => {
  const resolved = await resolvedQuery(store, narrowing, scope.timezone)
  try {
    const found = await store.notes.matchingRefs({
      root: resolved.root,
      limit: RANK_WITHIN,
      ...(scope.folderIds ? { folderIds: scope.folderIds } : {}),
      ...(scope.withInternal ? { withInternal: true } : {}),
      ...(scope.source ? { source: scope.source } : {}),
      ...(resolved.stemmer ? { stemmer: resolved.stemmer } : {}),
    })
    return found.hasMore ? undefined : found.refs
  } catch (error) {
    if (tooLarge(error)) return undefined
    throw error
  }
}

const tooLarge = (error: unknown) => isCliError(error) && error.details.reason === "query.too-large"

/**
 * The notes the words find, with those found by meaning: every note the search would list, paged to the end. Never
 * below what the page already showed; a count the store refuses as too costly is that lower bound.
 */
const notesTotal = async (
  store: MessageStore,
  text: string,
  {
    exact,
    scope,
    shown,
    hasMore,
  }: {
    exact: boolean
    scope: Pick<NotesSearchRequest, "folderIds" | "withInternal" | "source" | "timezone">
    shown: number
    hasMore: boolean
  },
  others: string[],
  othersComplete: boolean,
): Promise<SearchTotal> => {
  let words: { refs: string[]; hasMore: boolean }
  try {
    const { root, stemmer } = await storeQuery(store, text, {
      exact,
      ...(scope.timezone ? { timezone: scope.timezone } : {}),
    })
    words = await store.notes.matchingRefs({
      root,
      limit: TOTAL_CAP,
      ...(scope.folderIds ? { folderIds: scope.folderIds } : {}),
      ...(scope.withInternal ? { withInternal: true } : {}),
      ...(scope.source ? { source: scope.source } : {}),
      ...(stemmer ? { stemmer } : {}),
    })
  } catch (error) {
    if (tooLarge(error)) return totalOf(undefined, shown, hasMore)
    throw error
  }
  const count = new Set([...words.refs, ...others]).size + (words.hasMore ? 1 : 0)
  return totalOf(count, shown, hasMore, othersComplete)
}

/**
 * `search notes`: words and stems, and meaning when the local model is there, merged by reciprocal rank;
 * each hit says which half found it, and the answer lists what the notes found link to. Every field of the query and
 * of `filter` holds for every hit, found by words or by meaning; a query of fields alone is not searched by meaning.
 */
export const searchNotes = async (
  store: MessageStore,
  query: string,
  {
    limit = 20,
    offset = 0,
    tag,
    filter: expression,
    folderIds,
    withInternal,
    source: given,
    exact = false,
    timezone,
    env,
    command,
    embedders,
    pictures: withPictures = false,
    pictureLimit = 5,
    pictureEmbedder,
  }: NotesQuery = {},
): Promise<NotesFound> => {
  const typed = noteSourceOfQuery(query)
  const source = given ?? typed.source
  const rest = typed.source !== undefined && typed.source === source ? typed.rest : query
  const label = tag === undefined ? undefined : normalizeTag(tag)
  const filter =
    [expression ? `(${expression})` : "", label === undefined ? "" : `tag:${label}`].filter(Boolean).join(" AND ") ||
    undefined
  const parsed = query.trim() ? parsedQuery(query, exact) : undefined
  const words = parsed === undefined ? "" : meaningWords(parsed)
  const narrowing = allOf([
    ...(parsed === undefined ? [] : [fieldsOfQuery(parsed)].filter((node) => node !== undefined)),
    ...(filter === undefined ? [] : [parsedQuery(filter)]),
  ])
  const text = [query.trim() ? `(${query})` : "", filter ?? ""].filter(Boolean).join(" AND ")
  const window = offset + limit
  const scope = {
    ...(folderIds === undefined ? {} : { folderIds }),
    ...(withInternal ? { withInternal: true } : {}),
    ...(source === undefined ? {} : { source }),
    ...(timezone === undefined ? {} : { timezone }),
  }
  let meaningSkipped: string | undefined
  let meaning: { ref: string; note: Note; at: string }[] | undefined
  /** Every note found by meaning; `meaningComplete` is false when the nearest overall were cut at the depth. */
  let meaningRefs: Set<string> | undefined
  let meaningComplete = true
  if (exact) meaningSkipped = "--exact searches words as written"
  else if (words) {
    const lane = {
      command,
      ...(env === undefined ? {} : { env }),
      ...(embedders === undefined ? {} : { embedders }),
      ...(folderIds === undefined ? {} : { folderIds }),
      ...(withInternal ? { withInternal: true } : {}),
      ...(source === undefined ? {} : { source }),
    }
    const depth = Math.max(window, CANDIDATES)
    try {
      const within = narrowing === undefined ? undefined : await filterRefs(store, narrowing, scope)
      let nearest: { ref: string }[]
      if (within === undefined) {
        nearest = await nearestNotes(store, words, { ...lane, limit: depth })
        meaningComplete = nearest.length < depth
      } else {
        const ranked = within.length ? await nearestAmong(store, words, within, lane) : []
        meaningRefs = new Set(ranked.map(({ ref }) => ref))
        nearest = ranked.slice(0, depth)
      }
      const allowed = await matching(
        store,
        nearest.map(({ ref }) => ref),
        narrowing,
        scope,
      )
      meaning = nearest.flatMap(({ ref }) => {
        const found = allowed.get(ref)
        return found ? [{ ref, ...found }] : []
      })
      meaningRefs ??= new Set(meaning.map(({ ref }) => ref))
    } catch (error) {
      if (!(error instanceof CliError && error.code === "not_found")) throw error
      meaningSkipped = error.message
    }
  }
  const titleWords = plainQueryWords(rest)
  const titled =
    titleWords === undefined
      ? { items: [], hasMore: false }
      : await searchNotesQuery(store, {
          text: [titleQuery(titleWords), filter ?? ""].filter(Boolean).join(" AND "),
          limit: Math.max(window, CANDIDATES),
          ...scope,
        })
  const tier = titleWords === undefined ? [] : titleTiers(titled.items, titleWords)
  const tierRefs = new Set(tier.map(({ ref }) => ref))
  const slice = meaning === undefined && tier.length === 0
  const matched = await searchNotesQuery(store, {
    text,
    limit: slice ? limit : Math.max(window, CANDIDATES) + tier.length,
    offset: slice ? offset : 0,
    exact,
    ...scope,
  })
  const ranked = new Map<string, Held>()
  const add = (list: { ref: string; note: Note; at: string }[], by: "words" | "meaning") =>
    list.forEach(({ ref, note, at }, rank) => {
      if (tierRefs.has(ref)) return
      const held = ranked.get(ref) ?? { note, at, score: 0, foundBy: [] }
      held.score += 1 / (RRF_K + rank + 1)
      held.foundBy.push(by)
      ranked.set(ref, held)
    })
  add(matched.items, "words")
  if (meaning !== undefined) add(meaning, "meaning")
  const ordered = [
    ...tier.map(({ ref, note, at }): [string, Held] => [ref, { note, at, score: 0, foundBy: ["title"] }]),
    ...[...ranked.entries()].sort(([, a], [, b]) => b.score - a.score),
  ]
  const page = slice ? ordered : ordered.slice(offset, window)
  const hasMore = slice ? matched.hasMore : ordered.length > window || matched.hasMore || titled.hasMore
  const total = await notesTotal(
    store,
    text,
    { exact, scope, shown: offset + page.length, hasMore },
    [...tier.map(({ ref }) => ref), ...(meaningRefs ?? [])],
    meaningComplete,
  )
  const hits: FoundNote[] = []
  const counts = new Map<string, LinkedRecord>()
  const accounts = await store.accounts.storedAccounts()
  const profiles = await store.accounts.profiles()
  for (const [ref, { note, at, foundBy }] of page) {
    const links = (await store.notes.links({ from: ref })).map(({ to, targetText, kind, anchor }) => ({
      to,
      target_text: targetText,
      kind,
      anchor,
    }))
    hits.push({
      ref,
      source: note.source,
      folder_id: note.folderId,
      path: note.path,
      title: note.title,
      ...documentSource(
        note,
        accounts,
        profiles,
        note.source === "file" ? (await store.files.ofDocument(note.ref))[0] : undefined,
      ),
      updated_at: at,
      excerpt: firstLine(note.text, words),
      links,
      found_by: foundBy,
    })
    for (const link of new Map(links.map((link) => [link.to ?? `?${link.target_text}`, link])).values()) {
      const key = link.to ?? `?${link.target_text}`
      const known = counts.get(key) ?? { ref: link.to, name: link.target_text, notes: 0 }
      known.notes++
      counts.set(key, known)
    }
  }
  const names = new Map<string, string>(
    [...(await store.knowledge.organizations()), ...(await store.knowledge.projects())].map(({ ref, name }) => [
      ref,
      name,
    ]),
  )
  for (const record of counts.values()) {
    if (record.ref && names.has(record.ref)) record.name = names.get(record.ref) ?? record.name
    if (record.ref?.startsWith("person:"))
      record.name = (await store.people.personByUid(record.ref.slice("person:".length)))?.name ?? record.name
    if (record.ref?.startsWith("note:") || record.ref?.startsWith("document:"))
      record.name = (await store.notes.note(record.ref).catch(() => undefined))?.title ?? record.name
  }
  const lane = withPictures
    ? await pictureLane(store, words, {
        folderIds,
        source,
        limit: pictureLimit,
        env,
        command,
        embedder: pictureEmbedder,
      })
    : {}
  if (lane.pictures && narrowing !== undefined) {
    const allowed = await matching(
      store,
      lane.pictures.map(({ ref }) => ref),
      narrowing,
      scope,
    )
    lane.pictures = lane.pictures.filter(({ ref }) => allowed.has(ref))
  }
  return {
    query,
    ...(label === undefined ? {} : { tag: label }),
    ...(filter === undefined ? {} : { filter }),
    by: meaning === undefined ? "words" : "words and meaning",
    ...(meaningSkipped === undefined ? {} : { meaning_skipped: meaningSkipped }),
    hits,
    total,
    has_more: hasMore,
    ...(hasMore && window <= MAX_NOTES_OFFSET ? { next_offset: window } : {}),
    linked: [...counts.values()].sort(
      (a, b) => b.notes - a.notes || (a.name ?? a.ref ?? "").localeCompare(b.name ?? b.ref ?? ""),
    ),
    ...lane,
  }
}

/** What `notes:internal` and `notes:<folder id>` ask of the store: one query, so a page of it is one page. */
export const notesScopeOf = (
  accounts: readonly AccountKey[],
): Pick<NotesQuery, "folderIds" | "withInternal" | "source"> => {
  const folderIds = accounts.map(({ account }) => account).filter((account) => account !== INTERNAL_NOTES)
  if (!folderIds.length) return { source: "internal" }
  return { folderIds, ...(accounts.length > folderIds.length ? { withInternal: true } : {}) }
}

export interface NotesFoundOf extends NotesFound {
  /** Every notes account read: `internal` and each folder's id. */
  accounts: { resource: "notes"; provider: "notes"; account: string }[]
  /** A `--source` entry naming nothing `search notes` reads. */
  skipped: SkippedSource[]
}

/**
 * `search notes` with `--source`: the notes accounts the list names — `notes:internal`, `notes:<folder id>`, `notes`
 * — and every entry naming none of them in `skipped`. Without a list, every notes account `type` leaves in.
 */
export const searchNotesOf = async (
  store: MessageStore,
  account: AccountKey,
  text: string,
  {
    accounts: list,
    app,
    ...query
  }: Omit<NotesQuery, "folderIds" | "withInternal"> & { accounts?: string; app?: AppIdentity },
): Promise<NotesFoundOf> => {
  const own = app?.command ?? query.command
  const what = `${own === undefined ? "" : `${own} `}search notes`
  const held = [
    { provider: "notes", account: INTERNAL_NOTES },
    ...(await store.notes.folders()).map(({ id }) => ({ provider: "notes", account: id })),
    ...(await store.notes.documentsAccounts()).map(({ id }) => ({ provider: "notes", account: id })),
  ]
  const named =
    list === undefined
      ? { accounts: held, skipped: [] }
      : fitting(entriesOfList(list, await listContextOf(store, account, app)), ["notes", "documents"], what)
  const source = query.source ?? noteSourceOfQuery(text).source
  const typed = named.accounts.filter(
    ({ account }) => source === undefined || (account === INTERNAL_NOTES) === (source === "internal"),
  )
  if (!typed.length && list !== undefined)
    throw new CliError(
      "validation_error",
      source === "internal"
        ? "the query's source:internal keeps the notes written in memo, and the --source list names none of them: " +
            "add notes:internal to --source, or drop source:internal from the query"
        : "the query's source:file keeps the files from notes folders, and the --source list names none of them: " +
            "add notes:<folder id> to --source, or drop source:file from the query",
    )
  const scope = list === undefined ? {} : notesScopeOf(typed)
  const found = await searchNotes(store, text, {
    ...query,
    ...scope,
    ...(source ? { source } : {}),
  })
  return {
    ...found,
    accounts: typed.map(({ account }) => ({ resource: "notes", provider: "notes", account })),
    skipped: named.skipped,
  }
}
