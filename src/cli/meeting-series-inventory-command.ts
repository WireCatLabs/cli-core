import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import { previewFlag, REMOTE_READ } from "./effects.js"
import { type MeetingSeriesInventoryReader, readMeetingSeriesInventory } from "./meeting-series-inventory-read.js"

const integer = (value: string) => {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new CliError("validation_error", "expected a positive safe integer")
  return Number(value)
}
export const addMeetingSeriesInventoryCommand = (
  program: Command,
  deps: {
    read: MeetingSeriesInventoryReader
    signal: () => AbortSignal | undefined
    now?: () => number
    output: (answer: Awaited<ReturnType<typeof readMeetingSeriesInventory>>) => void
  },
) => {
  const meetings = program.commands.find((command) => command.name() === "meetings")
  if (!meetings) throw new CliError("configuration_error", "meeting command group is unavailable")
  return annotate(
    meetings
      .command("scheduled")
      .description("discover candidate meeting series from one bounded provider page")
      .option("--since-time <time>", "absolute window start as ISO timestamp with zone (default now)")
      .option("--before-time <time>", "exclusive ISO window end (default seven days after start)")
      .option("--limit <n>", "series candidates in one provider page, 1–100 (default 100)", integer)
      .option("--max-read-bytes <bytes>", "normalized provider-page bytes, at most 1048576 (default 65536)", integer)
      .option("--bytes <bytes>", "answer item UTF-8 JSON bytes, 2048–1048576 (default 65536)", integer)
      .option("--cursor <cursor>", "continue with the same absolute window and returned page cursor")
      .action(async (options: Record<string, unknown>) =>
        deps.output(
          await readMeetingSeriesInventory(
            deps.read,
            {
              after: options.sinceTime,
              until: options.beforeTime,
              limit: options.limit,
              max_read_bytes: options.maxReadBytes,
              bytes: options.bytes,
              cursor: options.cursor,
            },
            deps.signal(),
            deps.now?.(),
          ),
        ),
      ),
    {
      origin: "handwritten",
      effects: REMOTE_READ,
      offline: false,
      output: { entity: "meeting_series_inventory" },
      examples: [`${program.name()} meetings scheduled${previewFlag(program)} --json`],
    },
  )
}
