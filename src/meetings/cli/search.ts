import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import { Command } from "commander"
import { meetingHitsList } from "../answers.js"
import type { MeetingSearchPage } from "../search-store.js"
import { type MeetingHitSearchOptions, validateMeetingHitSearch } from "../search-validation.js"

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
export interface MeetingSearchFlags {
  meetingId?: number
  identityId?: number
  personId?: number
  eventId?: number
  seriesId?: number
  project?: string
  tag?: string
  topic?: string
  sinceTime?: number
  untilTime?: number
  limit?: number
  cursor?: string
  maxReadBytes?: number
}
/**
 * `search meetings`. The host's `search` closure reindexes before it reads (`refreshMeetingIndex`). It receives
 * every parsed option, so a host can add options to the returned command and choose another source from them.
 */
export const addMeetingSearchCommand = (
  program: Command,
  deps: {
    search: (
      query: string,
      request: MeetingHitSearchOptions,
      options: MeetingSearchFlags & Record<string, unknown>,
    ) => Promise<MeetingSearchPage>
    signal: () => AbortSignal | undefined
    output: (value: unknown) => void
  },
): Command => {
  let search = program.commands.find((command) => command.name() === "search")
  if (!search) {
    search = new Command("search").description("search the stored resources")
    program.addCommand(search)
  }
  const command = search
    .command("meetings")
    .description("find words in stored meetings, indexing new ones first")
    .argument("<query>", "words to find; each also matches its other word forms")
    .option("--meeting-id <id>", "only this stored meeting", integer)
    .option("--identity-id <id>", "meetings with this participant identity; does not say who spoke a hit", integer)
    .option("--person-id <id>", "meetings with a participant linked to this person", integer)
    .option("--event-id <id>", "only meetings linked to this stored event", integer)
    .option("--series-id <id>", "only meetings in this stored series", integer)
    .option("--project <name>", "meetings confirmed in this project, by name, key or alias")
    .option("--tag <name>", "meetings with this tag, by name or alias")
    .option("--topic <name>", "meetings with this topic, by name or alias")
    .option("--since-time <time>", "meetings starting at or after this ISO 8601 date or time", timestamp)
    .option("--until-time <time>", "meetings starting at or before this ISO 8601 date or time", timestamp)
    .option("--limit <n>", "how many hits, 1 through 1000 (default 100)", integer)
    .option("--cursor <cursor>", "continue from the previous page's page.cursor, with the same query and filters")
    .option("--max-read-bytes <bytes>", "most stored bytes to read, 1 through 67108864 (default 4194304)", integer)
    .action(async (query: string, options: MeetingSearchFlags & Record<string, unknown>) => {
      const request: MeetingHitSearchOptions = {
        meetingId: options.meetingId,
        participantIdentityId: options.identityId,
        personId: options.personId,
        eventId: options.eventId,
        meetingSeriesId: options.seriesId,
        project: options.project,
        tag: options.tag,
        topic: options.topic,
        since: options.sinceTime,
        until: options.untilTime,
        limit: options.limit,
        after: options.cursor,
        maxReadBytes: options.maxReadBytes,
        signal: deps.signal(),
      }
      validateMeetingHitSearch(query, request)
      deps.output(meetingHitsList(await deps.search(query, request, options), request.limit ?? 100))
    })
  annotate(command, { origin: "handwritten", mutates: false, output: { entity: "meeting_hit" } })
  return command
}
