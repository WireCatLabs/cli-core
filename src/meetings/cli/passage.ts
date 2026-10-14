import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
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
/** The host fixes account scope, connection lifetime and final rendering/output limits. */
export const addMeetingPassageCommand = (
  program: Command,
  deps: {
    read: MeetingPassageReader
    signal: () => AbortSignal | undefined
    output: (result: MeetingPassageResult, format: MeetingPassageOutputFormat) => void
  },
) => {
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
      )
      .action(
        async (
          reference: string,
          options: Omit<MeetingPassageRequest, "before" | "after" | "max_read_bytes" | "expected_fingerprint"> & {
            beforeN?: number
            afterN?: number
            maxReadBytes?: number
            expectedFingerprint?: string
          },
          command: Command,
        ) => {
          const globals = command.optsWithGlobals()
          const format = globals.json || globals.jsonl ? "json" : (options.format ?? "text")
          const input = {
            before: options.beforeN,
            after: options.afterN,
            bytes: options.bytes,
            max_read_bytes: options.maxReadBytes,
            expected_fingerprint: options.expectedFingerprint,
            format,
            signal: deps.signal(),
          }
          validateMeetingPassage(reference, input)
          input.signal?.throwIfAborted()
          const result = await deps.read(reference, input)
          input.signal?.throwIfAborted()
          deps.output(result, format)
        },
      ),
    {
      origin: "handwritten",
      effects: { remote: "none", local: "read" },
      examples: [`${program.name()} meetings passage meeting:1/1/1/0 --json`],
    },
  )
}
