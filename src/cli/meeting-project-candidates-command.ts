import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import type { StoredMeetingProjectCandidateReader } from "../services/index.js"
import { LOCAL_READ } from "./effects.js"
import { readMeetingProjectCandidates } from "./meeting-project-candidates-read.js"

const integer = (value: string) => {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new CliError("validation_error", "expected a positive safe integer")
  return Number(value)
}
export const addMeetingProjectCandidatesCommand = (
  program: Command,
  deps: {
    read: StoredMeetingProjectCandidateReader
    signal: () => AbortSignal | undefined
    output: (answer: Awaited<ReturnType<typeof readMeetingProjectCandidates>>) => void
  },
) => {
  const meetings = program.commands.find((command) => command.name() === "meetings")
  if (!meetings) throw new CliError("configuration_error", "meeting command group is unavailable")
  const projects =
    meetings.commands.find((command) => command.name() === "projects") ??
    meetings.command("projects").description("project evidence in stored meetings")
  return annotate(
    projects
      .command("scan")
      .description("suggest existing projects from one bounded page of stored meeting evidence")
      .argument("<ref>", "canonical parent meeting reference in the selected account")
      .option("--limit <n>", "existing project candidates, 1–10 (default 10)", integer)
      .option("--cues <n>", "transcript cues, 1–100 (default 20)", integer)
      .option("--bytes <bytes>", "answer item UTF-8 JSON bytes, 2048–65536 (default 16384)", integer)
      .option("--max-read-bytes <bytes>", "stored text bytes per read, 1–65536 (default 65536)", integer)
      .option("--cursor <cursor>", "continue from evidence.coverage.next_cursor with the same meeting")
      .action(async (ref: string, options: Record<string, unknown>) =>
        deps.output(
          await readMeetingProjectCandidates(
            deps.read,
            {
              ref,
              limit: options.limit,
              cues: options.cues,
              bytes: options.bytes,
              max_read_bytes: options.maxReadBytes,
              cursor: options.cursor,
            },
            deps.signal(),
          ),
        ),
      ),
    {
      origin: "handwritten",
      mcp: false,
      effects: LOCAL_READ,
      output: { entity: "meeting_project_candidates" },
      examples: [`${program.name()} meetings projects scan meeting:1/2 --json`],
    },
  )
}
