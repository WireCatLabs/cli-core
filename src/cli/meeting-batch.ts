import {
  BATCH_LIMITS,
  type BatchHandler,
  type BatchReport,
  type BatchResult,
  CliError,
  prepareBatch,
  runBatch,
} from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { Meta } from "@wirecat/cli-base/standards"
import { Command, Option } from "commander"
import { failureContext } from "../errors/reasons.js"
import {
  createMeetingPassageCommand,
  createMeetingSearchCommand,
  type MeetingPassageFlags,
  type MeetingSearchFlags,
  meetingHitSearchRequest,
  meetingPassageRequest,
  meetingSearchArguments,
} from "../meetings/cli/index.js"
import {
  type MeetingBatchReader,
  type MeetingHitContextPacket,
  type MeetingHitItem,
  type MeetingPassageOutputFormat,
  meetingHitsList,
  parseMeetingReference,
} from "../meetings/index.js"
import { formatMeetingEvidenceText, formatMeetingPassage } from "../services/meeting-passage-format.js"
import { type Body, itemOf, listOf } from "./envelope.js"

const INDEX_BYTES = 4194304
const parse = (command: Command, args: readonly string[]) => {
  command
    .exitOverride()
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .helpOption(false)
    .allowExcessArguments(false)
    .action(() => {})
  try {
    command.parse([...args], { from: "user" })
  } catch {
    throw new CliError(
      "validation_error",
      `invalid batch arguments for ${command.name()}; consult its single-command help`,
    )
  }
  return command
}
const handlers = (reader: MeetingBatchReader, meta: () => Meta): BatchHandler[] => {
  let indexed: Promise<{ remaining: number }> | undefined
  return [
    {
      command: ["search", "meetings"],
      prepare(args) {
        const command = parse(createMeetingSearchCommand(new Command()), args)
        const query = command.processedArgs[0] as string
        const flags = command.opts<MeetingSearchFlags>()
        const request = meetingHitSearchRequest(query, flags)
        return {
          run: async (ctx) => {
            ctx.reserveReadBytes(request.maxReadBytes ?? 4194304)
            if (!indexed) {
              ctx.reserveReadBytes(INDEX_BYTES)
              indexed = Promise.resolve().then(() => reader.index({ maxReadBytes: INDEX_BYTES, signal: ctx.signal }))
            }
            const index = await indexed
            const found = await reader.search(query, { ...request, signal: ctx.signal })
            if (index.remaining > 0) found.coverage = { ...found.coverage, indexing: "pending" }
            const complete = found.coverage.indexing === "ready"
            const answer = {
              ...meetingHitsList(found, request.limit ?? 100, "search meetings", meetingSearchArguments(query, flags)),
              meta: {
                ...meta(),
                complete,
                ...(!complete ? { issues: [{ code: "invalid_response" as const, source: "meeting-index" }] } : {}),
              },
            }
            return { answer, complete }
          },
        }
      },
    },
    {
      command: ["meetings", "passage"],
      prepare(args) {
        const root = new Command()
        root.command("meetings")
        const command = parse(createMeetingPassageCommand(root), args)
        const reference = command.processedArgs[0] as string
        const flags = command.opts<MeetingPassageFlags>()
        if (command.getOptionValueSource("format") === "cli" && flags.format !== "json")
          throw new CliError("validation_error", "choose text or markdown on batch, not on a nested passage")
        const request = meetingPassageRequest(reference, { ...flags, format: "json" })
        const parsed = parseMeetingReference(reference)
        if (parsed.transcriptId === undefined || parsed.cuePosition === undefined)
          throw new CliError("validation_error", "batch passage requires a retained transcript cue reference")
        return {
          run: async (ctx) => {
            ctx.reserveReadBytes(request.max_read_bytes ?? 4194304)
            const result = await reader.passage(reference, { ...request, signal: ctx.signal })
            const complete = result.packet.coverage.truncated_by === null
            return {
              answer: {
                ...itemOf(result.packet),
                meta: {
                  ...meta(),
                  complete,
                  ...(!complete ? { issues: [{ code: "invalid_response" as const, source: "passage-output" }] } : {}),
                },
              },
              complete,
            }
          },
        }
      },
    },
  ]
}

export const prepareMeetingBatch = (input: string, reader: MeetingBatchReader, meta: () => Meta) =>
  prepareBatch(input, handlers(reader, meta))

const textResult = (result: BatchResult, format: "text" | "markdown") => {
  const title = `${result.id}: ${result.command.join(" ")}`
  if (result.status !== "ok")
    return `${title}\n${result.status}: ${result.error.code} (${result.error.reason}): ${formatMeetingEvidenceText(result.error.message, format)}\n`
  const body = result.answer as Body
  if (result.command[0] === "meetings")
    return `${title}\n${formatMeetingPassage((body as { item: MeetingHitContextPacket }).item, format)}`
  const hits = (body as { items: MeetingHitItem[] }).items
  const hitText = (hit: MeetingHitItem) =>
    [hit.ref, hit.source?.title, hit.source?.started_at, hit.source?.url, hit.excerpt]
      .filter((value): value is string => value !== undefined && value !== null)
      .map((value) => formatMeetingEvidenceText(value, format))
      .join("\n")
  return `${title}\n${hits.map(hitText).join("\n\n")}\nCoverage: ${JSON.stringify({ page: "page" in body ? body.page : undefined, missing: body.missing, meta: body.meta })}\n`
}
export const formatMeetingBatch = (report: BatchReport, format: "text" | "markdown") =>
  report.items.map((result) => textResult(result, format)).join("\n")

export const addMeetingBatchCommand = (
  program: Command,
  deps: {
    reader: MeetingBatchReader
    input: (path: string, signal?: AbortSignal) => Promise<string>
    meta: () => Meta
    signal: () => AbortSignal | undefined
    fields: () => readonly string[] | undefined
    output: (body: Body, report: BatchReport, format: MeetingPassageOutputFormat) => void
  },
) => {
  const command = program
    .command("batch")
    .description("run bounded stored meeting reads: search meetings and meetings passage")
    .argument("<file>", "JSON request file, or - for stdin")
    .option(
      "--max-read-bytes <bytes>",
      "aggregate stored-text read ceilings, including one 4 MiB index pass; at most 67108864",
      (value: string) => {
        if (
          !/^[1-9]\d*$/.test(value) ||
          !Number.isSafeInteger(Number(value)) ||
          Number(value) > BATCH_LIMITS.read_bytes
        )
          throw new CliError("validation_error", "batch read budget takes 1–67108864 bytes")
        return Number(value)
      },
    )
    .addOption(
      new Option("--format <format>", "text, markdown or json").choices(["text", "markdown", "json"]).default("text"),
    )
    .addHelpText(
      "after",
      '\nInput: {"requests":[{"id":"q1","command":["search","meetings"],"args":["budget"]}]}\nEach input has its own args, cursor and fingerprint. No model calls or remote writes are dispatched.\nAt most 32 inputs / 256 KiB input / 64 MiB reserved text reads / 4 MiB output.\nPartial read results exit 0 with meta.complete false; malformed requests exit 2.\nField selectors apply to each answer and preserve result ids, errors and coverage.\n',
    )
    .action(async (path: string, options: { maxReadBytes?: number; format: string }, action: Command) => {
      const globals = action.optsWithGlobals()
      const format = globals.json || globals.jsonl ? "json" : options.format
      if (!["text", "markdown", "json"].includes(format))
        throw new CliError("validation_error", "choose text, markdown or json")
      const fields = deps.fields()
      if (fields && format !== "json")
        throw new CliError("validation_error", "batch field selection requires JSON output")
      const input = await deps.input(path, deps.signal())
      const requests = prepareMeetingBatch(input, deps.reader, deps.meta)
      const report = await runBatch(requests, {
        signal: deps.signal(),
        maxReadBytes: options.maxReadBytes,
        maxOutputBytes: Math.min(globals.maxOutputBytes || BATCH_LIMITS.output_bytes, BATCH_LIMITS.output_bytes),
        fields,
        failureContext: failureContext(),
      })
      const issues = report.items
        .filter((item) => !item.complete)
        .map((item) => ({
          code:
            item.status === "ok"
              ? ("invalid_response" as const)
              : item.error.code === "internal_error"
                ? ("invalid_response" as const)
                : item.error.code,
          source: item.id,
        }))
      deps.output(
        listOf("batch", {
          items: report.items,
          limit: report.items.length,
          has_more: false,
          meta: {
            complete: report.complete,
            ...(issues.length ? { issues } : {}),
            ...(report.output_limited ? { truncated: true } : {}),
          },
        }),
        report,
        format as MeetingPassageOutputFormat,
      )
    })
  return annotate(command, {
    origin: "handwritten",
    partial: true,
    effects: { remote: "none", local: "write" },
    examples: [`${program.name()} batch requests.json --json`],
  })
}
