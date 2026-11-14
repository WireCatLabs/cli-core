import { annotate } from "@wirecat/cli-base/commands"
import { timezoneOf } from "@wirecat/cli-base/query"
import { type Command, InvalidArgumentError } from "commander"
import { parseDuration } from "../domain/duration.js"
import { callStatsItem } from "../meetings/index.js"
import type { CallStatsAnswer, CallStatsRequest } from "../services/call-stats.js"
import { dateWindow } from "../services/moment.js"
import { outputFor } from "./context.js"
import { LOCAL_READ, NO_EFFECTS } from "./effects.js"
import { type Body, itemOf, renderAnswer } from "./envelope.js"

export type CallStatsRead = (request: Omit<CallStatsRequest, "accountId">) => Promise<CallStatsAnswer>

export interface CallStatsCommandDeps {
  /** The calls of the profile's own account; opened when the command runs. */
  read: () => Promise<CallStatsRead>
  signal?: () => AbortSignal | undefined
  /** Prints the answer; cli-core's renderer when not given. A host that closes its store first passes its own. */
  output?: (body: Body, command: Command) => void
  /** One to three examples that run as written, with the host's command and a profile. */
  examples: string[]
}

interface CallStatsFlags {
  sinceTime?: string
  untilTime?: string
  timezone?: string
  personId?: number
  within?: number
  limit?: number
}

const positive = (value: string) => {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new InvalidArgumentError("expected a positive integer")
  return Number(value)
}

/**
 * `stats calls show`, for a host whose meetings are phone calls: it mounts the command, so a host of video meetings
 * never shows it. Numbers over the stored calls only; nothing is read from the phone system.
 */
export const addCallStatsCommand = (program: Command, deps: CallStatsCommandDeps): void => {
  const stats =
    program.commands.find((command) => command.name() === "stats") ??
    annotate(program.command("stats"), { effects: NO_EFFECTS }).description("statistics")
  const calls = annotate(stats.command("calls"), { effects: NO_EFFECTS }).description(
    "numbers about the stored phone calls",
  )
  annotate(calls.command("show"), { effects: LOCAL_READ, output: { entity: "call_stats" }, examples: deps.examples })
    .summary("calls by direction, outcome, employee, hour and day; missed calls and callbacks")
    .description(
      "calls by direction and outcome, per employee, by hour and by day; missed incoming calls and whether the " +
        "client was called back; short calls. What the phone system does not record is counted as unknown",
    )
    .option("--since-time <time>", "calls starting at or after this date or time (ISO 8601, or 30d ago)")
    .option("--until-time <time>", "calls starting at or before this date or time; a date alone is that whole day")
    .option("--timezone <zone>", "the IANA zone hours and days are read in (default: this computer's)")
    .option(
      "--person-id <id>",
      "only calls this stored person took part in; a phone system that keeps no one who only rang misses those",
      positive,
    )
    .option("--within <duration>", "how long after a missed call a callback counts (default 1d)", (value) =>
      parseDuration(value, "--within"),
    )
    .option("--limit <n>", "most missed calls listed one by one, newest first (default 100); all are counted", positive)
    .action(async (flags: CallStatsFlags, command: Command) => {
      const zone = timezoneOf(flags.timezone)
      const window = dateWindow({ sinceTime: flags.sinceTime, untilTime: flags.untilTime, zone })
      const signal = deps.signal?.()
      const found = await (await deps.read())({
        ...(window.since === undefined ? {} : { since: window.since }),
        ...(window.until === undefined ? {} : { until: window.until }),
        ...(flags.personId === undefined ? {} : { personId: flags.personId }),
        ...(flags.within === undefined ? {} : { callbackWithinMs: flags.within }),
        ...(flags.limit === undefined ? {} : { missedLimit: flags.limit }),
        ...(signal ? { signal } : {}),
        timeZone: zone,
      })
      const body = itemOf(callStatsItem(found), { meta: { ...window.meta, timezone: zone } })
      if (deps.output) deps.output(body, command)
      else renderAnswer(command, outputFor(command), body)
    })
}
