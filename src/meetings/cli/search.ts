import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { Command } from "commander"
import { type MeetingHitSearch, type MeetingHitSearchOptions, validateMeetingHitSearch } from "../search-validation.js"

export { type MeetingHitSearch, type MeetingHitSearchOptions, validateMeetingHitSearch } from "../search-validation.js"

const integer = (value: string): number => {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new CliError("validation_error", "expected a positive safe integer")
  return Number(value)
}
const timestamp = (value: string): number => {
  const parsed = Date.parse(value)
  const date = value.slice(0, 10)
  const day = Date.parse(`${date}T00:00:00Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}(?:T.+(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) ||
    !Number.isFinite(parsed) ||
    !Number.isFinite(day) ||
    new Date(day).toISOString().slice(0, 10) !== date
  )
    throw new CliError("validation_error", "meeting search dates require a real ISO date or timestamp with offset")
  return parsed
}
export const addMeetingHitSearchCommand = (
  program: Command,
  deps: {
    search: () => Promise<MeetingHitSearch>
    signal: () => AbortSignal | undefined
    output: (value: unknown) => void
  },
) => {
  const meetings = program.commands.find((command) => command.name() === "meetings")
  if (!meetings) throw new CliError("configuration_error", "meeting command group is unavailable")
  annotate(
    meetings
      .command("search-page")
      .description("find words in stored meetings, by context filters, one page at a time")
      .argument("<query>", "words to find; each also matches its other word forms")
      .option("--meeting-id <id>", "restrict to a meeting in the selected account", integer)
      .option(
        "--identity-id <id>",
        "meetings with this observed participant identity; does not attribute speech",
        integer,
      )
      .option("--person-id <id>", "meetings with a participant explicitly linked to this person", integer)
      .option("--project <name>", "confirmed membership in a canonical project, key or explicit alias")
      .option("--tag <name>", "an explicit meeting tag, by canonical name or alias")
      .option("--topic <name>", "an explicit meeting topic, by canonical name or alias")
      .option("--since-time <time>", "meetings starting at or after this ISO 8601 date or time", timestamp)
      .option("--until-time <time>", "meetings starting at or before this ISO 8601 date or time", timestamp)
      .option("--limit <n>", "how many hits, 1 through 1000 (default 100)", integer)
      .option("--cursor <cursor>", "continue from the previous page's nextCursor, with the same query and filters")
      .option("--max-read-bytes <bytes>", "most stored bytes to read, 1 through 67108864 (default 4194304)", integer)
      .action(
        async (
          query: string,
          options: Omit<MeetingHitSearchOptions, "since" | "until" | "after"> & {
            identityId?: number
            sinceTime?: number
            untilTime?: number
            cursor?: string
          },
        ) => {
          const { identityId, sinceTime, untilTime, cursor, ...input } = options
          const request = {
            ...input,
            since: sinceTime,
            until: untilTime,
            after: cursor,
            participantIdentityId: identityId,
            signal: deps.signal(),
          }
          validateMeetingHitSearch(query, request)
          deps.output(await (await deps.search())(query, request))
        },
      ),
    { origin: "handwritten", mutates: false },
  )
}
