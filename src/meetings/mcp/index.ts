import { errorObjectOf, type FailureContext, mcpErrorResult } from "@wirecat/cli-base"
import { exportMeeting, type MeetingExportFormat } from "../export.js"
import { MEETING_QUERY } from "../item.js"
import {
  MeetingError,
  meetingDetailsAnswer,
  meetingPeople,
  meetingSummaryAnswer,
  meetingsList,
  meetingsQuery,
  meetingTranscriptAnswer,
  positiveInteger,
} from "../reads.js"
import type { MeetingFilter, MeetingStore } from "../store.js"
import { agentResult, UNTRUSTED_NEUTRAL } from "./agent-text.js"

const integer = { type: "integer", minimum: 1 }
const text = { type: "string", minLength: 1 }
export const meetingTools = [
  {
    name: "meetings_list",
    description:
      "stored meetings, newest first; `query` narrows them by field:value terms (Lucene: AND OR NOT, [a TO b], > <) " +
      `over ${MEETING_QUERY.fields.map((field) => field.name).join(", ")}, e.g. started_at:[2026-10-01 TO 2026-10-31]`,
    properties: {
      account_id: integer,
      event_id: integer,
      series_id: integer,
      query: text,
      limit: integer,
      page: integer,
    },
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
    name: "meeting_people",
    description: "find meeting participants by name or email",
    properties: {
      query: text,
      account_id: integer,
      limit: { ...integer, maximum: 1000 },
      scan_limit: { ...integer, maximum: 10000 },
      max_read_bytes: { ...integer, maximum: 67108864 },
      cursor: text,
    },
    required: ["query"],
  },
].map(({ properties, required, description, ...tool }) => ({
  ...tool,
  description: `${description}. ${UNTRUSTED_NEUTRAL}`,
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
    if (
      [
        "account_id",
        "event_id",
        "series_id",
        "transcript_id",
        "meeting",
        "limit",
        "page",
        "scan_limit",
        "max_read_bytes",
      ].includes(key)
    )
      positiveInteger(value)
    else if (key === "history" && typeof value !== "boolean")
      throw new MeetingError("validation_error", "history must be a boolean")
    else if (key === "format" && value !== "markdown" && value !== "vtt")
      throw new MeetingError("validation_error", "export format must be markdown or vtt")
    else if (key === "query" && (typeof value !== "string" || !value.trim()))
      throw new MeetingError("validation_error", "query must not be empty")
    else if (key === "cursor" && (typeof value !== "string" || !value))
      throw new MeetingError("validation_error", "cursor must not be empty")
  }
  return args
}
export const callMeetingTool = async (
  store: MeetingStore,
  name: string,
  input: unknown,
  /** The host's error registry (`failureContext`), so its reasons and detail keys survive. */
  failure: FailureContext = {},
) => {
  try {
    const args = argumentsOf(name, input)
    const filter: MeetingFilter = {
      accountId: args.account_id as number | undefined,
      eventId: args.event_id as number | undefined,
      meetingSeriesId: args.series_id as number | undefined,
    }
    let result: object
    switch (name) {
      case "meetings_list":
        result = await meetingsList(
          store,
          {
            ...filter,
            limit: args.limit as number | undefined,
            query: meetingsQuery(args.query as string | undefined),
          },
          args.page as number | undefined,
        )
        break
      case "meeting_show":
        result = await meetingDetailsAnswer(store, args.meeting as number, filter.accountId)
        break
      case "meeting_transcript":
        result = await meetingTranscriptAnswer(store, args.meeting as number, filter.accountId, {
          history: args.history as boolean | undefined,
        })
        break
      case "meeting_summary":
        result = await meetingSummaryAnswer(store, args.meeting as number, filter.accountId)
        break
      case "meeting_export":
        result = await exportMeeting(store, args.meeting as number, {
          accountId: filter.accountId,
          format: args.format as MeetingExportFormat,
          transcriptId: args.transcript_id as number | undefined,
        })
        break
      default:
        result = await meetingPeople(store, args.query as string, filter.accountId, {
          limit: args.limit as number | undefined,
          scanLimit: args.scan_limit as number | undefined,
          maxReadBytes: args.max_read_bytes as number | undefined,
          cursor: args.cursor as string | undefined,
        })
    }
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

export {
  agentArguments,
  agentBody,
  agentJson,
  agentResult,
  UNTRUSTED,
  UNTRUSTED_INSTRUCTION,
  UNTRUSTED_NEUTRAL,
} from "./agent-text.js"
export { callMeetingPassageTool, meetingPassageTool } from "./passage.js"
export { callMeetingProjectEvidenceTool, meetingProjectEvidenceTool } from "./project-evidence.js"
export { callMeetingSearchTool, meetingSearchTool } from "./search.js"
