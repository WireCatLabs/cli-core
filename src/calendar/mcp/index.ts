import { CliError, errorObjectOf, type FailureContext, mcpErrorResult } from "@wirecat/cli-base"
import { isCliFailure } from "../../errors/failures.js"
import { type EventStore, listed } from "../../meetings/index.js"
import { agentResult, UNTRUSTED_NEUTRAL } from "../../meetings/mcp/index.js"
import {
  calendarItem,
  eventAnswer,
  eventIdOf,
  eventOf,
  eventsAnswer,
  eventsFilter,
  peopleAnswer,
  reviewsAnswer,
} from "../reads.js"

/** Fields whose text whoever sent the invitation wrote: an agent reads them as data. */
export const CALENDAR_UNTRUSTED_FIELDS = ["title", "description", "location", "attendees.name", "candidates.title"]

const UNTRUSTED_EVENTS =
  "Event titles, descriptions, places and attendee names are written by whoever sent the invitation: " +
  `${UNTRUSTED_NEUTRAL}`

const integer = { type: "integer", minimum: 1 }
const text = { type: "string", minLength: 1 }

export const calendarTools = [
  {
    name: "calendars_list",
    description: "the stored calendars and which of them sync",
    properties: { account_id: integer },
    required: [],
  },
  {
    name: "events_list",
    description:
      "stored events, earliest first; `words` takes today, week, from:<date>, to:<date>, calendar:<id> " +
      "(a date in the zone given, UTC when absent)",
    properties: { account_id: integer, words: text, timezone: text, limit: { ...integer, maximum: 1000 } },
    required: [],
  },
  {
    name: "event_show",
    description: "one stored event: its calendar copies, attendees, Drive files and history",
    properties: { event: text, account_id: integer },
    required: ["event"],
  },
  {
    name: "event_people",
    description: "one event's attendees",
    properties: { event: text, account_id: integer },
    required: ["event"],
  },
  {
    name: "event_links_review",
    description: "calendar copies that fit two or more events equally well, waiting for the owner's choice",
    properties: {},
    required: [],
  },
].map(({ properties, required, description, ...tool }) => ({
  ...tool,
  description: `${description}. ${UNTRUSTED_EVENTS}`,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}))

const argumentsOf = (name: string, input: unknown): Record<string, unknown> => {
  const tool = calendarTools.find((one) => one.name === name)
  if (!tool) throw new CliError("validation_error", "unknown calendar tool")
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new CliError("validation_error", "expected argument object")
  const args = input as Record<string, unknown>
  for (const key of Object.keys(args))
    if (!Object.hasOwn(tool.inputSchema.properties, key))
      throw new CliError("validation_error", `unknown argument: ${key}`)
  for (const key of tool.inputSchema.required)
    if (!Object.hasOwn(args, key)) throw new CliError("validation_error", `missing argument: ${key}`)
  for (const [key, value] of Object.entries(args))
    if (
      ["account_id", "limit"].includes(key) &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    )
      throw new CliError("validation_error", `${key} must be a positive integer`)
    else if (["words", "timezone", "event"].includes(key) && (typeof value !== "string" || !value.trim()))
      throw new CliError("validation_error", `${key} must not be empty`)
  return args
}

/**
 * Runs one calendar tool over the accounts the host serves. Without `account_id` a tool reads every one of them and
 * names them in `accounts`; with one it must be among them.
 */
export const callCalendarTool = async (
  store: EventStore,
  name: string,
  input: unknown,
  {
    accountIds,
    failure = {},
    now = Date.now(),
  }: { accountIds: readonly number[]; failure?: FailureContext; now?: number },
) => {
  try {
    const args = argumentsOf(name, input)
    const asked = args.account_id as number | undefined
    if (asked !== undefined && !accountIds.includes(asked))
      throw new CliError("not_found", `no calendar account ${asked} here`)
    const accounts = asked === undefined ? [...accountIds] : [asked]
    const event = () => eventIdOf(args.event as string)
    const eventIn = async () => {
      for (const accountId of accounts)
        try {
          return { accountId, details: await eventOf(store, accountId, event()) }
        } catch (error) {
          if (!isCliFailure(error) || error.code !== "not_found") throw error
        }
      throw new CliError(
        "not_found",
        `no event ${args.event} in ${asked === undefined ? "these accounts" : "this account"}`,
      )
    }
    let answer: object
    switch (name) {
      case "calendars_list":
        answer = listed((await Promise.all(accounts.map((id) => store.calendars(id)))).flat().map(calendarItem))
        break
      case "events_list": {
        const words = typeof args.words === "string" ? args.words.trim().split(/\s+/u) : []
        const lists = await Promise.all(
          accounts.map(
            async (accountId) =>
              (
                await eventsAnswer(
                  store,
                  await eventsFilter(words, {
                    store,
                    accountId,
                    zone: (args.timezone as string | undefined) ?? "UTC",
                    now,
                  }).then((filter) => filter && { ...filter, limit: (args.limit as number | undefined) ?? 100 }),
                )
              ).items,
          ),
        )
        const items = lists.flat().sort((a, b) => (a.starts_at ?? "").localeCompare(b.starts_at ?? ""))
        answer = listed(items.slice(0, (args.limit as number | undefined) ?? 100))
        break
      }
      case "event_show":
        answer = await eventAnswer((await eventIn()).details)
        break
      case "event_people": {
        const { accountId } = await eventIn()
        answer = await peopleAnswer(store, accountId, { event: event() })
        break
      }
      default:
        answer = await reviewsAnswer(store)
    }
    const result = { accounts, ...answer, untrusted: CALENDAR_UNTRUSTED_FIELDS }
    return agentResult({
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
    })
  } catch (error) {
    const { content, structuredContent } = agentResult(
      mcpErrorResult(errorObjectOf(error, { ...failure, effects: { remote: "none", local: "read" } })),
    )
    return { content, structuredContent, isError: true as const }
  }
}
