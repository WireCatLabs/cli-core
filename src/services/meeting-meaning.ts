import { CliError } from "@wirecat/cli-base"
import type { MeetingHitSearchRequest } from "../meetings/index.js"
import type { MessageStore } from "../store/store.js"
import type { ModelChoice } from "./embeddings.js"
import type { MeetingEmbedder } from "./meeting-model.js"

export interface MeetingModelOptions {
  model: string
  baseUrl?: string
  dims?: number
}

export interface MeetingMeaningSearchOptions extends MeetingModelOptions {
  /** Split new transcripts and embed passages that have no vector first. */
  buildMissing?: boolean
  limit?: number
  maxChunks?: number
  /** The meetings both searches read: the word search's own filters, names unresolved. */
  selection?: Omit<MeetingHitSearchRequest, "accountId" | "limit" | "after" | "maxReadBytes" | "signal">
  /** The previous page's cursor. */
  after?: string
  maxRows?: number
  maxTextBytes?: number
  signal?: AbortSignal
}

export interface MeetingEmbeddingOptions extends MeetingModelOptions {
  limit?: number
  maxRows?: number
  maxTextBytes?: number
  yes?: boolean
  signal?: AbortSignal
}

type Combined = Awaited<ReturnType<typeof import("./meeting-combined.js").searchMeetingsCombined>>

export interface MeetingMeaning {
  search: (query: string, options: MeetingMeaningSearchOptions) => Promise<Combined>
  generate: (options: MeetingEmbeddingOptions) => Promise<Record<string, unknown>>
}

const bounded = (value: number | undefined, maximum: number) =>
  value === undefined || (Number.isSafeInteger(value) && value > 0 && value <= maximum)

export const validateMeetingModel = (options: MeetingModelOptions): void => {
  if (typeof options.model !== "string" || !options.model.trim() || options.model.length > 1000)
    throw new CliError("validation_error", "select an explicit embedding model")
  if (options.baseUrl === undefined) {
    if (options.dims !== undefined)
      throw new CliError("validation_error", "dimensions require an explicit remote base URL")
    return
  }
  let url: URL
  try {
    url = new URL(options.baseUrl)
  } catch {
    throw new CliError("validation_error", "embedding base URL must be an HTTP or HTTPS URL")
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^[\w./:-]{1,200}$/.test(options.model) ||
    options.dims === undefined ||
    !bounded(options.dims, 8192)
  )
    throw new CliError(
      "validation_error",
      "remote embeddings require an HTTP base URL without credentials and explicit dimensions",
    )
}

export const validateMeetingMeaningSearch = (query: string, options: MeetingMeaningSearchOptions): void => {
  validateMeetingModel(options)
  if (
    typeof query !== "string" ||
    !query.trim() ||
    Buffer.byteLength(query, "utf8") > 65536 ||
    !bounded(options.limit, 1000) ||
    !bounded(options.maxChunks, 100000) ||
    !bounded(options.maxRows, 100000) ||
    !bounded(options.maxTextBytes, 64 * 1024 * 1024)
  )
    throw new CliError(
      "validation_error",
      "meeting semantic search requires a nonempty bounded query and positive limits",
    )
}

export const validateMeetingEmbeddings = (options: MeetingEmbeddingOptions): void => {
  validateMeetingModel(options)
  if (
    !bounded(options.limit, 1000) ||
    !bounded(options.maxRows, 100000) ||
    !bounded(options.maxTextBytes, 64 * 1024 * 1024)
  )
    throw new CliError("validation_error", "meeting embedding generation requires valid bounded limits")
}

export type MeetingMeaningApi = Pick<
  typeof import("./meeting-model.js"),
  "meetingEmbeddingModel" | "createMeetingRemoteModel" | "openMeetingEmbedder"
> &
  Pick<typeof import("./meeting-combined.js"), "searchMeetingsCombined"> &
  Pick<typeof import("./meeting-semantic.js"), "proposeMeetingEmbedding" | "applyMeetingEmbedding">

// The embedding runtime is heavy; a command that never asks for meaning never loads it.
const loadApi = async (): Promise<MeetingMeaningApi> => {
  const [model, combined, semantic] = await Promise.all([
    import("./meeting-model.js"),
    import("./meeting-combined.js"),
    import("./meeting-semantic.js"),
  ])
  return { ...model, ...combined, ...semantic }
}

const checkCancelled = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return
  if (signal.reason instanceof CliError) throw signal.reason
  const timedOut = signal.reason instanceof Error && signal.reason.name === "TimeoutError"
  throw new CliError(timedOut ? "timeout" : "cancelled", timedOut ? "command timed out" : "command cancelled")
}

/**
 * Search by meaning and the vectors it reads, over one account's stored meetings. A local model keeps the
 * transcripts on this computer; `baseUrl` sends passages to that service and is only ever chosen by the caller.
 */
export const meetingMeaning = (
  store: Pick<MessageStore, "meetings" | "meetingVectors"> & { knowledge?: MessageStore["knowledge"] },
  accountId: number,
  options: { env?: NodeJS.ProcessEnv; load?: () => Promise<MeetingMeaningApi> } = {},
): MeetingMeaning => {
  if (!Number.isSafeInteger(accountId) || accountId < 1)
    throw new CliError("validation_error", "meeting vectors require a selected positive account ID")
  const load = options.load ?? loadApi
  const choice = (api: MeetingMeaningApi, input: MeetingModelOptions): ModelChoice =>
    input.baseUrl === undefined
      ? input.model
      : { remote: api.createMeetingRemoteModel({ model: input.model, baseUrl: input.baseUrl, dims: input.dims }) }
  const budget = (input: { maxRows?: number; maxTextBytes?: number; signal?: AbortSignal }) => ({
    maxRows: input.maxRows,
    maxTextBytes: input.maxTextBytes,
    signal: input.signal,
  })
  // rebuild has no "new transcripts only" mode, so every pass splits every current transcript again; only
  // passages without a vector for this model reach the embedder.
  const splitAll = async (input: { maxRows?: number; maxTextBytes?: number; signal?: AbortSignal }) => {
    let afterTranscriptId: number | undefined
    let pages = 0
    for (;;) {
      checkCancelled(input.signal)
      const page = await store.meetingVectors.rebuild({ accountId, limit: 1000, afterTranscriptId, ...budget(input) })
      pages += 1
      if (!page.hasMore || page.nextTranscriptId === undefined) return { pages }
      afterTranscriptId = page.nextTranscriptId
    }
  }
  const buildMissing = async (
    api: MeetingMeaningApi,
    embedder: MeetingEmbedder,
    input: MeetingMeaningSearchOptions,
  ) => {
    await splitAll(input)
    let afterHash: string | undefined
    for (;;) {
      checkCancelled(input.signal)
      const batch = await api.applyMeetingEmbedding(store.meetingVectors, accountId, embedder, {
        afterHash,
        ...budget(input),
      })
      if (!batch.hasMore || batch.nextHash === undefined) return
      afterHash = batch.nextHash
    }
  }
  return {
    search: async (query, input) => {
      validateMeetingMeaningSearch(query, input)
      checkCancelled(input.signal)
      const api = await load()
      checkCancelled(input.signal)
      const embedder = await api.openMeetingEmbedder(choice(api, input), { env: options.env, signal: input.signal })
      try {
        if (input.buildMissing) await buildMissing(api, embedder, input)
        return await api.searchMeetingsCombined(store, embedder, query, {
          ...input.selection,
          accountId,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.after === undefined ? {} : { after: input.after }),
          ...(input.maxChunks === undefined ? {} : { maxChunks: input.maxChunks }),
          ...(input.maxRows === undefined ? {} : { maxRows: input.maxRows }),
          ...(input.maxTextBytes === undefined ? {} : { maxTextBytes: input.maxTextBytes }),
          ...(input.signal ? { signal: input.signal } : {}),
        })
      } finally {
        await embedder.close()
      }
    },
    generate: async (input) => {
      validateMeetingEmbeddings(input)
      checkCancelled(input.signal)
      const api = await load()
      checkCancelled(input.signal)
      const selected = choice(api, input)
      const descriptor = api.meetingEmbeddingModel(selected, options.env)
      if (input.yes !== true)
        return api.proposeMeetingEmbedding(store.meetingVectors, accountId, descriptor, { signal: input.signal })
      const embedder = await api.openMeetingEmbedder(selected, { env: options.env, signal: input.signal })
      try {
        checkCancelled(input.signal)
        // Passages that already have a vector are never offered again, so the next run takes the next batch.
        const rebuild = await splitAll(input)
        checkCancelled(input.signal)
        const result = await api.applyMeetingEmbedding(store.meetingVectors, accountId, embedder, {
          maxChunks: input.limit,
          ...budget(input),
        })
        return { ...result, applied: true, model: descriptor, rebuild }
      } finally {
        await embedder.close()
      }
    },
  }
}
