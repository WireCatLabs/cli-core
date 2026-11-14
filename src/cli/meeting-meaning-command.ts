import { CliError } from "@wirecat/cli-base"
import { annotate, overrideSharedContract } from "@wirecat/cli-base/commands"
import { type Command, InvalidArgumentError } from "commander"
import {
  createMeetingSearchCommand,
  type MeetingHitSearch,
  type MeetingSearchFlags,
  meetingHitSearchRequest,
  meetingSearchArguments,
  meetingSearchMeta,
} from "../meetings/cli/index.js"
import { meetingHitsList } from "../meetings/index.js"
import type { MeetingEmbeddingOptions, MeetingMeaning } from "../services/meeting-meaning.js"
import { FETCH } from "./effects.js"
import { type Body, itemOf, listOf } from "./envelope.js"

const count = (value: string): number => {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new InvalidArgumentError("expected a positive integer")
  return Number(value)
}

interface MeaningFlags {
  model?: string
  baseUrl?: string
  dims?: number
  maxChunks?: number
  maxRows?: number
  maxTextBytes?: number
}
type SearchFlags = MeetingSearchFlags & MeaningFlags

const FLAG = {
  maxReadBytes: "--max-read-bytes",
  baseUrl: "--base-url",
  dims: "--dims",
  maxChunks: "--max-chunks",
  maxRows: "--max-rows",
  maxTextBytes: "--max-text-bytes",
} as const
const refuse = (options: SearchFlags, keys: readonly (keyof typeof FLAG)[], mode: string) => {
  const given = keys.filter((key) => options[key] !== undefined).map((key) => FLAG[key])
  if (given.length) throw new CliError("validation_error", `${given.join(", ")} do not apply ${mode}`)
}

// The root `--offline`: a remote `--base-url` would send the passages out.
const offline = (command: Command) => command.optsWithGlobals().offline === true

type Combined = Awaited<ReturnType<MeetingMeaning["search"]>>

/** Combined hits as the list answer: each cites a line, says how it was found, and keeps its passage. */
const combinedList = (found: Combined, limit: number, args: Record<string, unknown>): Body =>
  listOf("search meetings", {
    items: found.items.map((hit) => ({
      ref: hit.ref,
      meeting: hit.ref.split("/").slice(0, 2).join("/"),
      scope: hit.scope,
      excerpt: hit.text,
      offset_ms: hit.startMs,
      by: hit.by,
      score: hit.score,
      ...(hit.passage ? { passage: hit.passage } : {}),
      ...(hit.match ? { match: hit.match } : {}),
      ...(hit.corrections ? { corrections: hit.corrections } : {}),
      source: {
        ref: hit.ref,
        title: hit.source.title,
        started_at: hit.source.startedAt === null ? null : new Date(hit.source.startedAt).toISOString(),
        url: hit.source.url,
      },
      untrusted: ["excerpt", "passage.first", "passage.last", "source.title"],
    })),
    limit,
    has_more: found.hasMore,
    paging: "cursor",
    ...(found.nextCursor ? { cursor: found.nextCursor } : {}),
    args,
    missing: [
      ...(found.coverage.meaningScanComplete
        ? []
        : [{ field: "items", why: `meaning compared only ${found.coverage.scanned} passages; raise --max-chunks` }]),
      ...(found.words.refused ? [{ field: "items", why: `found by meaning only: ${found.words.refused}` }] : []),
    ],
  }) as Body

const MEANING_REASON = "search meetings also ranks by meaning with --model, over vectors built on this computer"

const withMeaningOptions = (command: Command): Command =>
  overrideSharedContract(command, MEANING_REASON, (one) => {
    one
      .description("find words in stored meetings, and by meaning with --model")
      .option(
        "--model <model>",
        "rank words and meaning together with this embedding model, building missing vectors first; local stays here",
      )
      .option("--base-url <url>", "remote embedding service for --model; the passages are sent there")
      .option("--dims <n>", "vector size the remote service returns, in dimensions", count)
      .option("--max-chunks <n>", "by meaning: most stored passages to compare (default 10000)", count)
      .option("--max-rows <n>", "by meaning: most transcript lines to read, 1 through 100000", count)
      .option("--max-text-bytes <bytes>", "by meaning: most transcript text to read (default 4 MiB)", count)
  })

export interface MeetingCombinedSearchDeps {
  words: () => Promise<MeetingHitSearch>
  meaning: () => Promise<MeetingMeaning>
  signal: () => AbortSignal | undefined
  /** The page without `--limit`: `pagingOf` from `@wirecat/cli-core/cli`, which reads the profile's limit. */
  pagingOf: (command: Command) => { limit: number }
  output: (body: Body, command: Command) => void
  /** One to three examples that run as written, with the host's command and a profile. */
  examples: string[]
}

export type MeetingSearchRun = (query: string, options: SearchFlags, command: Command) => Promise<Body>

/**
 * `search meetings` by words, and by words and meaning ranked together with `--model`, for any host of stored
 * meetings. Returns the run, so a host's saved searches replay it.
 */
export const addMeetingCombinedSearchCommand = (
  program: Command,
  deps: MeetingCombinedSearchDeps,
): MeetingSearchRun => {
  const execute: MeetingSearchRun = async (query, options, command) => {
    const request = meetingHitSearchRequest(query, options, deps.pagingOf(command).limit, deps.signal())
    if (options.model !== undefined) {
      refuse(options, ["maxReadBytes"], "to a search by meaning")
      const { limit, after, maxReadBytes: _bytes, signal, ...selection } = request
      if (options.baseUrl !== undefined && offline(command))
        throw new CliError("configuration_error", "remote embeddings require network access; remove --offline")
      const meaning = {
        model: options.model,
        baseUrl: options.baseUrl,
        dims: options.dims,
        limit,
        maxChunks: options.maxChunks,
        after,
        selection,
        maxRows: options.maxRows,
        maxTextBytes: options.maxTextBytes,
        buildMissing: true,
        signal,
      }
      return combinedList(
        await (await deps.meaning()).search(query, meaning),
        limit as number,
        meetingSearchArguments(query, options),
      )
    }
    refuse(options, ["baseUrl", "dims", "maxChunks", "maxRows", "maxTextBytes"], "without --model")
    return meetingHitsList(
      await (await deps.words())(query, request),
      request.limit as number,
      "search meetings",
      meetingSearchArguments(query, options),
      meetingSearchMeta(options),
    ) as Body
  }
  const command = withMeaningOptions(createMeetingSearchCommand(program)).action(
    async (query: string, options: SearchFlags, self: Command) =>
      deps.output(await execute(query, options, self), self),
  )
  overrideSharedContract(command, "a search by meaning may build missing vectors, so it writes to the store", (one) =>
    annotate(one, { origin: "handwritten", effects: FETCH, examples: deps.examples }),
  )
  return execute
}

export interface MeetingEmbeddingCommandDeps {
  meaning: () => Promise<MeetingMeaning>
  /** The local model used without `--model`: the `models` command's default text model. */
  defaultModel: () => string
  signal: () => AbortSignal | undefined
  output: (body: Body, command: Command) => void
  /** Where a write's answer goes when the host keeps a receipt of it; `output` otherwise. */
  receipt?: (body: Body, command: Command) => Promise<void>
  examples: string[]
}

/** `meetings embeddings`: previews the vectors a search by meaning needs, and `--yes` builds one batch of them. */
export const addMeetingEmbeddingCommand = (program: Command, deps: MeetingEmbeddingCommandDeps): void => {
  const meetings = program.commands.find((command) => command.name() === "meetings")
  if (!meetings) throw new CliError("configuration_error", "meeting command group is unavailable")
  annotate(
    meetings
      .command("embeddings")
      .description("preview building the vectors search by meaning reads; --yes builds one batch")
      .option("--model <model>", "embedding model: a local one (default: the models command's default text model)")
      .option("--base-url <url>", "remote embedding service; the passages are sent there. OpenAI reads OPENAI_API_KEY")
      .option("--dims <n>", "vector size the remote service returns, in dimensions", count)
      .option("--limit <n>", "how many transcripts and passages in one batch, 1 through 1000", count)
      .option("--max-rows <n>", "most transcript lines to read, 1 through 100000", count)
      .option("--max-text-bytes <bytes>", "most transcript text to read, in bytes (default 4 MiB)", count)
      .option("--after-transcript-id <id>", "continue splitting transcripts after this one", count)
      .option("--after-hash <hash>", "continue embedding after this passage")
      .option("--yes", "split transcripts and build their vectors; otherwise only preview")
      .action(async (flags: Omit<MeetingEmbeddingOptions, "model"> & { model?: string }, command: Command) => {
        if (flags.baseUrl !== undefined && flags.model === undefined)
          throw new CliError("validation_error", "a remote --base-url needs its own --model")
        if (flags.baseUrl !== undefined && offline(command))
          throw new CliError("configuration_error", "remote embeddings require network access; remove --offline")
        const options = { ...flags, model: flags.model ?? deps.defaultModel(), signal: deps.signal() }
        const body = itemOf(await (await deps.meaning()).generate(options))
        if (options.yes && deps.receipt) await deps.receipt(body, command)
        else deps.output(body, command)
      }),
    { origin: "handwritten", effects: FETCH, examples: deps.examples },
  )
}
