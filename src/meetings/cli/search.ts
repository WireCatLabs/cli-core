import { CliError } from "@wirecat/cli-base"
import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import { timezoneOf, zonedMoment } from "@wirecat/cli-base/query"
import type { Meta } from "@wirecat/cli-base/standards"
import { Command } from "commander"
import { meetingHitsList } from "../answers.js"
import type { MeetingSearchPage } from "../search-store.js"
import { type MeetingHitSearchOptions, validateMeetingHitSearch } from "../search-validation.js"

export { type MeetingHitSearch, type MeetingHitSearchOptions, validateMeetingHitSearch } from "../search-validation.js"

const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/i
const moment = (flag: string, end: boolean, readIn: (zone: string) => void) => (value: string) => {
  const zone = timezoneOf()
  let time: number
  try {
    time = zonedMoment(value, zone, { start: 0, end: value.length }, { end })
  } catch {
    throw new CliError("validation_error", `${flag} takes an ISO date, or a time with or without an offset`)
  }
  if (!ZONED.test(value.trim())) readIn(zone)
  return time
}
const integer = (value: string): number => {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new CliError("validation_error", "expected a positive safe integer")
  return Number(value)
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
  topicName?: string
  sinceTime?: number
  untilTime?: number
  /** The zone a date or time without one was read in; the parser sets it, since the typed text is gone after. */
  timesReadIn?: string
  limit?: number
  cursor?: string
  maxReadBytes?: number
}
/** Shared grammar without an action: a host with other source reports supplies their transport routing. */
const createMeetingSearchCommandDefinition = (program: Command): Command => {
  let search = program.commands.find((command) => command.name() === "search")
  if (!search) {
    search = new Command("search").description("search the stored resources")
    program.addCommand(search)
  }
  const readIn = (zone: string) => command.setOptionValue("timesReadIn", zone)
  const command: Command = search
    .command("meetings")
    .description("find words in stored meetings, indexing new ones first")
    .argument(
      "<query>",
      'words, OR, (groups), -word, "a phrase", "a b"~N (within N lines), exact:word, from:"Name" (who said the line); date>=30d, project:, tag:, topic: choose meetings; a word also matches its other forms and spellings speech recognition garbled',
    )
    .option("--meeting-id <id>", "only this stored meeting", integer)
    .option("--identity-id <id>", "meetings with this participant identity; does not say who spoke a hit", integer)
    .option("--person-id <id>", "meetings with a participant linked to this person", integer)
    .option("--event-id <id>", "only meetings linked to this stored event", integer)
    .option("--series-id <id>", "only meetings in this stored series", integer)
    .option("--project <project>", "meetings confirmed in this project, by name, key or alias")
    .option("--tag <name>", "meetings with this tag, by name or alias")
    .option("--topic-name <name>", "meetings with this topic, by name or alias")
    .option(
      "--since-time <time>",
      "meetings starting at or after this ISO 8601 date or time",
      moment("--since-time", false, readIn),
    )
    .option(
      "--until-time <time>",
      "meetings starting at or before this ISO 8601 date or time; a date alone covers that whole local day",
      moment("--until-time", true, readIn),
    )
    .option("--limit <n>", "how many hits, 1 through 1000 (default 100)", integer)
    .option("--cursor <cursor>", "continue from the previous page's page.next_cursor, with the same query and filters")
    .option("--max-read-bytes <bytes>", "most stored bytes to read, 1 through 67108864 (default 4194304)", integer)
  annotate(command, {
    origin: "handwritten",
    effects: { remote: "none", local: "read" },
    output: { entity: "meeting_hit" },
  })
  return command
}

/** Transport fields become one validated word request before a host opens its selected source. */
export const meetingHitSearchRequest = (
  query: string,
  options: MeetingSearchFlags,
  signal?: AbortSignal,
): MeetingHitSearchOptions => {
  const request: MeetingHitSearchOptions = {
    meetingId: options.meetingId,
    participantIdentityId: options.identityId,
    personId: options.personId,
    eventId: options.eventId,
    meetingSeriesId: options.seriesId,
    project: options.project,
    tag: options.tag,
    topic: options.topicName ?? options.topic,
    since: options.sinceTime,
    until: options.untilTime,
    limit: options.limit,
    after: options.cursor,
    maxReadBytes: options.maxReadBytes,
    signal,
  }
  validateMeetingHitSearch(query, request)
  signal?.throwIfAborted()
  return request
}

/** Parsed dates must become ISO values again so the CLI can replay its own continuation. */
export const meetingSearchArguments = (query: string, options: MeetingSearchFlags): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries({
      query,
      meeting_id: options.meetingId?.toString(),
      identity_id: options.identityId?.toString(),
      person_id: options.personId?.toString(),
      event_id: options.eventId?.toString(),
      series_id: options.seriesId?.toString(),
      project: options.project,
      tag: options.tag,
      topic_name: options.topicName ?? options.topic,
      since_time: options.sinceTime === undefined ? undefined : new Date(options.sinceTime).toISOString(),
      until_time: options.untilTime === undefined ? undefined : new Date(options.untilTime).toISOString(),
      max_read_bytes: options.maxReadBytes ?? 4194304,
    }).filter(([, value]) => value !== undefined),
  )

/** What `meta` says about the dates: the zone one without its own was read in, and the window in UTC. */
export const meetingSearchMeta = (options: MeetingSearchFlags): Pick<Meta, "timezone" | "window"> => {
  const window = {
    ...(options.sinceTime === undefined ? {} : { since: new Date(options.sinceTime).toISOString() }),
    ...(options.untilTime === undefined ? {} : { until: new Date(options.untilTime).toISOString() }),
  }
  return {
    ...(options.timesReadIn === undefined ? {} : { timezone: options.timesReadIn }),
    ...(Object.keys(window).length === 0 ? {} : { window }),
  }
}

const addMeetingSearchCommandDefinition = (
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
): Command =>
  createMeetingSearchCommand(program).action(
    async (query: string, options: MeetingSearchFlags & Record<string, unknown>) => {
      const request = meetingHitSearchRequest(query, options, deps.signal())
      deps.output(
        meetingHitsList(
          await deps.search(query, request, options),
          request.limit ?? 100,
          "search meetings",
          meetingSearchArguments(query, options),
          meetingSearchMeta(options),
        ),
      )
    },
  )

export const createMeetingSearchCommand = sharedCommand(createMeetingSearchCommandDefinition)

export const addMeetingSearchCommand = sharedCommand(addMeetingSearchCommandDefinition)
