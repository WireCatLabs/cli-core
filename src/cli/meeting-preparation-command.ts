import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import { REMOTE_READ } from "./effects.js"
import { type MeetingPreparationReader, readMeetingPreparation } from "./meeting-preparation-read.js"

const integer = (value: string) => {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new CliError("validation_error", "expected a positive safe integer")
  return Number(value)
}
export const addMeetingPreparationCommand = (
  program: Command,
  deps: {
    read: MeetingPreparationReader
    output: (answer: Awaited<ReturnType<typeof readMeetingPreparation>>) => void
    signal: () => AbortSignal | undefined
    now?: () => number
  },
) => {
  const group = program.commands.find((command) => command.name() === "meetings")
  if (!group) throw new CliError("configuration_error", "meeting command group is unavailable")
  return annotate(
    group
      .command("prepare")
      .argument("<series-id>", "exact provider series ID")
      .description("prepare cited context for one selected upcoming series; reads remote schedule and stored meetings")
      .option("--after <instant>", "window start as ISO timestamp with zone (default now)")
      .option("--until <instant>", "exclusive window end as ISO timestamp (default seven days after start)")
      .option("--history-after <instant>", "history start as ISO timestamp (default thirty days before start)")
      .option("--meetings <n>", "prior occurrences, 1–20 (default 5)", integer)
      .option("--cues <n>", "cues per occurrence, 1–100 (default 10)", integer)
      .option("--context-limit <n>", "entries per context category, 1–100 (default 20)", integer)
      .option("--max-read-bytes <bytes>", "stored/normalized bytes per read, at most 4194304 (default 262144)", integer)
      .option("--bytes <bytes>", "preparation item JSON bytes, 4096–4194304 (default 65536)", integer)
      .action(async (seriesId: string, options: Record<string, unknown>) =>
        deps.output(
          await readMeetingPreparation(
            deps.read,
            {
              series_id: seriesId,
              after: options.after,
              until: options.until,
              history_after: options.historyAfter,
              meetings: options.meetings,
              cues: options.cues,
              context_limit: options.contextLimit,
              max_read_bytes: options.maxReadBytes,
              bytes: options.bytes,
            },
            deps.signal(),
            deps.now?.(),
          ),
        ),
      ),
    { origin: "handwritten", effects: REMOTE_READ, output: { entity: "meeting_preparation" } },
  )
}
