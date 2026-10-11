import { exportMeeting, type MeetingExportFormat } from "../export.js"
import {
  listed,
  MeetingError,
  meetingShow,
  meetingSummary,
  meetingsList,
  meetingsSearch,
  meetingTranscript,
  positiveInteger,
} from "../reads.js"
import type { MeetingFilter, MeetingStore } from "../store.js"

const integer = { type: "integer", minimum: 1 }
const text = { type: "string", minLength: 1 }
const filters = {
  account_id: integer,
  event_id: integer,
  series_id: integer,
  since: { type: "number" },
  until: { type: "number" },
}
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
    properties: { meeting: integer, account_id: integer },
    required: ["meeting"],
  },
  {
    name: "meeting_transcript",
    description: "show current meeting transcripts",
    properties: { meeting: integer, account_id: integer, history: { type: "boolean" } },
    required: ["meeting"],
  },
  {
    name: "meeting_summary",
    description: "show stored meeting summaries",
    properties: { meeting: integer, account_id: integer },
    required: ["meeting"],
  },
  {
    name: "meeting_export",
    description: "export stored meeting content without writing a file",
    properties: {
      meeting: integer,
      account_id: integer,
      format: { type: "string", enum: ["markdown", "vtt"] },
      transcript_id: integer,
    },
    required: ["meeting", "format"],
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
    if (["account_id", "event_id", "series_id", "transcript_id", "meeting", "limit", "page"].includes(key))
      positiveInteger(value)
    else if (key === "history" && typeof value !== "boolean")
      throw new MeetingError("validation_error", "history must be a boolean")
    else if (key === "format" && value !== "markdown" && value !== "vtt")
      throw new MeetingError("validation_error", "export format must be markdown or vtt")
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
      eventId: args.event_id as number | undefined,
      meetingSeriesId: args.series_id as number | undefined,
      since: args.since as number | undefined,
      until: args.until as number | undefined,
    }
    let result: object
    switch (name) {
      case "meetings_list":
        result = await meetingsList(
          store,
          { ...filter, limit: args.limit as number | undefined },
          args.page as number | undefined,
        )
        break
      case "meeting_show":
        result = await meetingShow(store, args.meeting as number, filter.accountId)
        break
      case "meeting_transcript":
        result = await meetingTranscript(store, args.meeting as number, filter.accountId, {
          history: args.history as boolean | undefined,
        })
        break
      case "meeting_summary":
        result = await meetingSummary(store, args.meeting as number, filter.accountId)
        break
      case "meeting_export":
        result = await exportMeeting(store, args.meeting as number, {
          accountId: filter.accountId,
          format: args.format as MeetingExportFormat,
          transcriptId: args.transcript_id as number | undefined,
        })
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
        message: error instanceof MeetingError ? error.message : "Meeting read failed",
      },
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result,
      isError: true,
    }
  }
}
