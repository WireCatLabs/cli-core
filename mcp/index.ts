import {
  listed,
  MeetingError,
  meetingShow,
  meetingsList,
  meetingsSearch,
  meetingTranscript,
  positiveInteger,
} from "../reads.js"
import type { MeetingFilter, MeetingStore } from "../store.js"

const integer = { type: "integer", minimum: 1 }
const text = { type: "string", minLength: 1 }
const filters = { account_id: integer, since: { type: "number" }, until: { type: "number" } }
export const meetingTools = [
  {
    name: "meetings_list",
    description: "list stored meetings",
    properties: { ...filters, limit: integer, page: integer },
    required: [],
  },
  {
    name: "meeting_show",
    description: "show a stored meeting",
    properties: { meeting: integer },
    required: ["meeting"],
  },
  {
    name: "meeting_transcript",
    description: "show current meeting transcripts",
    properties: { meeting: integer },
    required: ["meeting"],
  },
  {
    name: "meetings_search",
    description: "search stored transcripts, chat and summaries",
    properties: { ...filters, query: text },
    required: ["query"],
  },
  {
    name: "meeting_people",
    description: "find meeting participants by name or email",
    properties: { query: text, account_id: integer },
    required: ["query"],
  },
].map(({ properties, required, ...tool }) => ({
  ...tool,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}))
const argumentsOf = (name: string, input: unknown): Record<string, unknown> => {
  const tool = meetingTools.find((t) => t.name === name)
  if (!tool) throw new MeetingError("validation_error", "unknown meeting tool")
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new MeetingError("validation_error", "expected argument object")
  const args = input as Record<string, unknown>
  for (const key of Object.keys(args))
    if (!Object.hasOwn(tool.inputSchema.properties, key))
      throw new MeetingError("validation_error", `unknown argument: ${key}`)
  for (const key of tool.inputSchema.required)
    if (!Object.hasOwn(args, key)) throw new MeetingError("validation_error", `missing argument: ${key}`)
  for (const [key, value] of Object.entries(args)) {
    if (["account_id", "meeting", "limit", "page"].includes(key)) positiveInteger(value)
    else if (key === "query" && (typeof value !== "string" || !value.trim()))
      throw new MeetingError("validation_error", "query must not be empty")
    else if (["since", "until"].includes(key) && (typeof value !== "number" || !Number.isFinite(value)))
      throw new MeetingError("validation_error", "expected epoch milliseconds")
  }
  return args
}
export const callMeetingTool = async (store: MeetingStore, name: string, input: unknown) => {
  try {
    const args = argumentsOf(name, input)
    const filter: MeetingFilter = {
      accountId: args.account_id as number | undefined,
      since: args.since as number | undefined,
      until: args.until as number | undefined,
    }
    let result: unknown
    switch (name) {
      case "meetings_list":
        result = await meetingsList(
          store,
          { ...filter, limit: args.limit as number | undefined },
          args.page as number | undefined,
        )
        break
      case "meeting_show":
        result = await meetingShow(store, args.meeting as number)
        break
      case "meeting_transcript":
        result = await meetingTranscript(store, args.meeting as number)
        break
      case "meetings_search":
        result = await meetingsSearch(store, args.query as string, filter)
        break
      default:
        result = listed(await store.participants(args.query as string, filter.accountId))
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result }
  } catch (error) {
    const result = {
      error: {
        code: error instanceof MeetingError ? error.code : "generic_failure",
        message: error instanceof Error ? error.message : "Meeting read failed",
      },
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
      isError: true,
    }
  }
}
