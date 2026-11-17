import { errorObjectOf, type FailureContext, mcpErrorResult } from "@wirecat/cli-base"
import { exportMeeting, type MeetingExportFormat } from "../export.js"
import { BACKENDS, type Backend } from "../index.js"
import { MEETING_QUERY } from "../item.js"
import { meetingShowThrough, meetingsListThrough } from "../read-through.js"
import {
  MeetingError,
  meetingDetailsAnswer,
  meetingDetailsBody,
  meetingPeople,
  meetingSummaryAnswer,
  meetingsList,
  meetingsQuery,
  meetingTranscriptAnswer,
  positiveInteger,
} from "../reads.js"
import type { MeetingSource } from "../source.js"
import type { MeetingFilter, MeetingStore } from "../store.js"
import { agentResult, UNTRUSTED_NEUTRAL } from "./agent-text.js"

const integer = { type: "integer", minimum: 1 }
const text = { type: "string", minLength: 1 }
const backend = {
  type: "string",
  enum: [...BACKENDS],
  description:
    "where to read: the store (archive), the service (server), or both, kept in the store; without it both, and the " +
    "store alone when the service cannot be asked, said in `missing`",
}
export const meetingTools = [
  {
    name: "meetings_list",
    description:
      "meetings, newest first: the service's, kept in the store, and the stored ones, as `backend` says; each item " +
      "says found_in archive, server or both when the service was asked. `query` narrows them by field:value terms " +
      `(Lucene: AND OR NOT, [a TO b], > <) over ${MEETING_QUERY.fields.map((field) => field.name).join(", ")}, ` +
      "e.g. started_at:[2026-10-01 TO 2026-10-31]",
    properties: {
      account_id: integer,
      event_id: integer,
      series_id: integer,
      query: text,
      limit: integer,
      page: integer,
      backend,
    },
    required: [],
    remote: true,
  },
  {
    name: "meeting_show",
    description:
      "show a stored meeting, read again from the service with its people, transcript and documents, as `backend` says",
    properties: { meeting: integer, account_id: integer, backend },
    required: ["meeting"],
    remote: true,
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
].map(({ properties, required, description, remote = false, ...tool }) => ({
  ...tool,
  description: `${description}. ${UNTRUSTED_NEUTRAL}`,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  // A read of the service keeps what it returns, as `meetings list` does, which still counts as a read (WC-CMD-17).
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: remote },
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
    else if (key === "backend" && !(BACKENDS as readonly unknown[]).includes(value))
      throw new MeetingError("validation_error", "backend must be archive, server or both")
  }
  return args
}

/** The run's account, which the tool caller may name but never change: the service is that account's. */
const accountOf = (args: Record<string, unknown>, bound: number | undefined): number | undefined => {
  const named = args.account_id as number | undefined
  if (bound === undefined || named === undefined || named === bound) return bound ?? named
  throw new MeetingError(
    "validation_error",
    `account_id ${named} is not this run's account; the tools read account ${bound} only`,
  )
}

const NO_SERVICE = {
  field: "server",
  why: "this host gives the tool no service to ask — the answer is the store's",
}
export const callMeetingTool = async (
  store: MeetingStore,
  name: string,
  input: unknown,
  {
    limit: configured,
    failure = {},
    source,
    accountId: bound,
    signal,
    timezone,
    now,
    offline,
  }: {
    /** A list's page without `limit`: the profile's `defaults.limit`, as the messenger MCP lists take it. */
    limit: number
    /** The host's error registry (`failureContext`), so its reasons and detail keys survive. */
    failure?: FailureContext
    /**
     * The run's meetings service: `meetings_list` and `meeting_show` read it and the store, as `meetings list` and
     * `show` do. It needs `accountId`.
     */
    source?: MeetingSource
    /**
     * The run's account, the one its profile names. Given, every tool reads that account only, and `meetings_list`
     * and `meeting_show` read the service as well (a source-less host's answer says the service was not asked).
     */
    accountId?: number
    /** The run's stop signal, handed to the service; a stopped read ends the call instead of answering from the store. */
    signal?: AbortSignal
    /** The owner's zone, in which a list query's dates are read on both sides; the computer's without it. */
    timezone?: string
    now?: number
    /** `--offline`: the service is not asked, and the answer says so. */
    offline?: boolean
  },
) => {
  const remote = bound !== undefined && (name === "meetings_list" || name === "meeting_show")
  try {
    if (source && bound === undefined)
      throw new MeetingError("configuration_error", "a meetings service needs the run's account (accountId)")
    const args = argumentsOf(name, input)
    const accountId = accountOf(args, bound)
    const filter: MeetingFilter = {
      accountId,
      eventId: args.event_id as number | undefined,
      meetingSeriesId: args.series_id as number | undefined,
    }
    const typed = args.backend as Backend | undefined
    if (bound === undefined && typed === "server")
      throw new MeetingError("validation_error", "backend server: this host gives the tool no service to ask")
    const access = {
      ...(typed === undefined ? {} : { backend: typed }),
      ...(offline ? { offline } : {}),
      ...(timezone === undefined ? {} : { timezone }),
      ...(now === undefined ? {} : { now }),
      ...(signal ? { signal } : {}),
    }
    const unasked = bound === undefined && typed === "both" ? { missing: [NO_SERVICE] } : {}
    let result: object
    switch (name) {
      case "meetings_list": {
        const limit = (args.limit as number | undefined) ?? configured
        const listFilter = {
          ...filter,
          limit,
          offset: (((args.page as number | undefined) ?? 1) - 1) * limit,
          query: meetingsQuery(args.query as string | undefined),
        }
        if (bound === undefined) {
          result = { ...(await meetingsList(store, listFilter)), ...unasked }
          break
        }
        // The standard envelope has no place for the counts; what the reader must know is in `missing` and `meta`.
        const { server: _server, ...answer } = await meetingsListThrough(
          source,
          store,
          { ...listFilter, accountId: bound },
          access,
        )
        result = answer
        break
      }
      case "meeting_show": {
        if (bound === undefined) {
          result = { ...(await meetingDetailsAnswer(store, args.meeting as number, filter.accountId)), ...unasked }
          break
        }
        const shown = await meetingShowThrough(source, store, bound, String(args.meeting), access)
        const { item } = await meetingDetailsBody(store, shown.details)
        result = {
          item: shown.foundIn ? { ...item, found_in: shown.foundIn } : item,
          ...(shown.missing ? { missing: shown.missing } : {}),
          ...(shown.meta ? { meta: shown.meta } : {}),
        }
        break
      }
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
      mcpErrorResult(
        errorObjectOf(error, { ...failure, effects: { remote: remote ? "read" : "none", local: "read" } }),
      ),
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
