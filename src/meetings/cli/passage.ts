import { CliError } from "@wirecat/cli-base"
import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import { type Command, Option } from "commander"
import {
  type MeetingPassageOutputFormat,
  type MeetingPassageReader,
  type MeetingPassageRequest,
  type MeetingPassageResult,
  validateMeetingPassage,
} from "../passage.js"

const count = (value: string) => {
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new CliError("validation_error", "expected a nonnegative safe integer")
  return Number(value)
}
export interface MeetingPassageFlags {
  beforeN?: number
  afterN?: number
  bytes?: number
  maxReadBytes?: number
  expectedFingerprint?: string
  format?: MeetingPassageOutputFormat
}

export const meetingPassageRequest = (
  reference: string,
  options: MeetingPassageFlags,
  signal?: AbortSignal,
): MeetingPassageRequest => {
  const input: MeetingPassageRequest = {
    before: options.beforeN,
    after: options.afterN,
    bytes: options.bytes,
    max_read_bytes: options.maxReadBytes,
    expected_fingerprint: options.expectedFingerprint,
    format: options.format ?? "text",
    signal,
  }
  validateMeetingPassage(reference, input)
  signal?.throwIfAborted()
  return input
}

const createMeetingPassageCommandDefinition = (program: Command): Command => {
  const meetings = program.commands.find((command) => command.name() === "meetings")
  if (!meetings) throw new CliError("configuration_error", "meeting command group is unavailable")
  return annotate(
    meetings
      .command("passage")
      .description("read a cited cue with bounded context before and after it")
      .argument("<reference>", "retained transcript cue reference from a search hit")
      .option("--before-n <n>", "preceding cues (default 3)", count)
      .option("--after-n <n>", "following cues (default 3); at most 999 surrounding cues in total", count)
      .option("--bytes <bytes>", "cue JSON byte budget (default 65536); the anchor must fit", count)
      .option(
        "--max-read-bytes <bytes>",
        "stored text byte budget (default 4194304); boundary probes read metadata only",
        count,
      )
      .option("--expected-fingerprint <hash>", "reject a changed anchor using its previously read cue fingerprint")
      .addOption(
        new Option("--format <format>", "compact text, Markdown or structured JSON")
          .choices(["text", "markdown", "json"])
          .default("text"),
      ),
    {
      origin: "handwritten",
      effects: { remote: "none", local: "read" },
      output: { entity: "meeting_passage" },
      examples: [`${program.name()} meetings passage meeting:1/1/1/0 --json`],
    },
  )
}

/** The host fixes account scope, connection lifetime and final rendering/output limits. */
const addMeetingPassageCommandDefinition = (
  program: Command,
  deps: {
    read: MeetingPassageReader
    signal: () => AbortSignal | undefined
    output: (result: MeetingPassageResult, format: MeetingPassageOutputFormat) => void
  },
) =>
  createMeetingPassageCommand(program).action(
    async (reference: string, options: MeetingPassageFlags, command: Command) => {
      const globals = command.optsWithGlobals()
      const format = globals.json || globals.jsonl ? "json" : (options.format ?? "text")
      const input = meetingPassageRequest(reference, { ...options, format }, deps.signal())
      const result = await deps.read(reference, input)
      input.signal?.throwIfAborted()
      deps.output(result, format)
    },
  )

export const createMeetingPassageCommand = sharedCommand(createMeetingPassageCommandDefinition)

export const addMeetingPassageCommand = sharedCommand(addMeetingPassageCommandDefinition)
