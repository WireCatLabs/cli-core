import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import { defineQuery, fieldsHelp, parseLucene, timezoneOf, validateQuery, zonedMoment } from "@wirecat/cli-base/query"
import type { Effects } from "@wirecat/cli-base/standards"
import { type Command, InvalidArgumentError, Option } from "commander"
import { EVENT_QUERY } from "../event-query.js"
import { exportMeeting, type MeetingExportFormat } from "../export.js"
import { type ImportFile, importFiles } from "../import.js"
import { MEETING_QUERY } from "../item.js"
import type { MeetingParticipantSearchOptions } from "../participant-search.js"
import { pull } from "../pull.js"
import { eventItem } from "../read-answers.js"
import {
  listed,
  MEETING_QUERY_GUIDE,
  MeetingError,
  meetingDetailsAnswer,
  meetingPeople,
  meetingSummaryAnswer,
  meetingsList,
  meetingsQuery,
  meetingTranscriptAnswer,
} from "../reads.js"
import { SAVE_HELP } from "../save-hints.js"
import type { MeetingSource } from "../source.js"
import type { MeetingStore } from "../store.js"
import { queryWordsAfterOptions } from "./query-options.js"

export interface MeetingCommandDeps {
  store: MeetingStore
  accountId: number
  source?: MeetingSource
  readFiles?: (folder: string) => Promise<ImportFile[]>
  /** The host's file names and how it reads their time, shown in `meetings import --help`. */
  importHelp?: string
  writeFile?: (path: string, content: string) => Promise<void>
  write: (value: unknown, format: "json" | "jsonl" | "text") => void
  now?: () => number
}
const integer = (text: string) => {
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text)))
    throw new InvalidArgumentError("expected a positive integer")
  return Number(text)
}
const lookbackDays = (text: string) => {
  if (!/^(0|[1-9]\d*)$/.test(text) || Number(text) > 31)
    throw new InvalidArgumentError("expected an integer from 0 through 31 days")
  return Number(text)
}
const date = (text: string) => {
  try {
    return zonedMoment(text, timezoneOf(), { start: 0, end: text.length })
  } catch {
    throw new InvalidArgumentError("expected an ISO date, or a time with or without an offset")
  }
}
const LOCAL_READ: Effects = { remote: "none", local: "read" }
const LOCAL_WRITE: Effects = { remote: "none", local: "write" }
const FETCH: Effects = { remote: "read", local: "write" }

const addMeetingCommandsDefinition = (program: Command, deps: MeetingCommandDeps): void => {
  const group = annotate(program.command("meetings").description("stored meetings and their records"), {
    effects: { remote: "none", local: "none" },
  })
  const output = (command: Command) =>
    command
      .option("--json", "one JSON value")
      .option("--jsonl", "one JSON object per item")
      .hook("preAction", (cmd) => {
        const opts = cmd.optsWithGlobals()
        if (opts.json && opts.jsonl) throw new MeetingError("validation_error", "choose --json or --jsonl")
      })
  const print = (value: unknown, command: Command) => {
    const opts = command.optsWithGlobals()
    deps.write(value, opts.json ? "json" : opts.jsonl ? "jsonl" : "text")
  }
  const list = queryWordsAfterOptions(group.command("list").description("stored meetings, newest first"))
    .argument("[query...]", "field:value terms that narrow the list — the fields are below")
    .addHelpText("after", `\n${fieldsHelp(MEETING_QUERY, MEETING_QUERY_GUIDE)}`)
  annotate(list, { effects: LOCAL_READ, query: defineQuery(MEETING_QUERY), output: { entity: "meeting" } })
  output(list)
    .option("--limit <n>", "meetings per page", integer, 100)
    .option("--page <n>", "page number", integer, 1)
    .action(async (words: string[], opts: { limit: number; page: number }, command: Command) => {
      const query = meetingsQuery(words.join(" "))
      print(
        await meetingsList(
          deps.store,
          { accountId: deps.accountId, limit: opts.limit, ...(query ? { query } : {}) },
          opts.page,
        ),
        command,
      )
    })
  output(
    annotate(group.command("show"), { effects: LOCAL_READ, output: { entity: "meeting_details" } })
      .description("show a stored meeting")
      .argument("<meeting>", "stored meeting id", integer)
      .addHelpText("after", SAVE_HELP),
  ).action(async (id: number, _opts: unknown, command: Command) => {
    print(await meetingDetailsAnswer(deps.store, id, deps.accountId), command)
  })
  output(
    annotate(group.command("transcript"), { effects: LOCAL_READ, output: { entity: "meeting_transcript" } })
      .description("show current meeting transcripts")
      .argument("<meeting>", "stored meeting id", integer)
      .option("--history", "include superseded transcript versions")
      .addHelpText("after", SAVE_HELP),
  ).action(async (id: number, opts: { history?: boolean }, command: Command) => {
    print(await meetingTranscriptAnswer(deps.store, id, deps.accountId, { history: opts.history }), command)
  })
  output(
    annotate(group.command("summary"), { effects: LOCAL_READ, output: { entity: "meeting_summary" } })
      .description("show stored meeting summaries")
      .argument("<meeting>", "stored meeting id", integer),
  ).action(async (id: number, _opts: unknown, command: Command) => {
    print(await meetingSummaryAnswer(deps.store, id, deps.accountId), command)
  })
  output(
    annotate(group.command("export"), { effects: LOCAL_WRITE, output: { entity: "meeting_export" } })
      .description("export a meeting as Markdown or one transcript as WebVTT")
      .argument("<meeting>", "stored meeting id", integer)
      .addOption(new Option("--format <format>", "export format").choices(["markdown", "vtt"]).default("markdown"))
      .option("--transcript-id <id>", "export a specific transcript version", integer)
      .option("--output <file>", "write content to a file through the host's writer"),
  ).action(
    async (
      id: number,
      opts: { format: MeetingExportFormat; transcriptId?: number; output?: string },
      command: Command,
    ) => {
      if (opts.output !== undefined && !opts.output.trim())
        throw new MeetingError("validation_error", "output path must not be empty")
      if (opts.output !== undefined && !deps.writeFile)
        throw new MeetingError("configuration_error", "the host has no export file writer")
      const result = await exportMeeting(deps.store, id, {
        accountId: deps.accountId,
        format: opts.format,
        transcriptId: opts.transcriptId,
      })
      if (opts.output !== undefined) {
        await deps.writeFile?.(opts.output, result.content)
        print({ meetingId: result.meetingId, format: result.format, output: opts.output }, command)
      } else print(result, command)
    },
  )
  output(
    annotate(group.command("people"), { effects: LOCAL_READ, output: { entity: "meeting_participants" } })
      .description("find meeting participants by name or email")
      .argument("<query>", "a name or an email address"),
  )
    .option("--limit <n>", "most matching observations per page, 1–1000 (default 50)", integer)
    .option("--scan-limit <n>", "most participant observations to inspect, 1–10000 (default 1000)", integer)
    .option("--max-read-bytes <bytes>", "most stored name and email bytes to read (default 1048576)", integer)
    .option("--cursor <cursor>", "continue with the same name query and selected account")
    .action(async (query: string, opts: Omit<MeetingParticipantSearchOptions, "accountId">, command: Command) => {
      print(
        await meetingPeople(deps.store, query, deps.accountId, {
          limit: opts.limit,
          scanLimit: opts.scanLimit,
          maxReadBytes: opts.maxReadBytes,
          cursor: opts.cursor,
        }),
        command,
      )
    })
  output(
    annotate(group.command("sync"), {
      effects: FETCH,
      offline: false,
      output: { entity: "meeting_ingestion" },
    }).description("bring the stored meetings up to date from the connected account"),
  )
    .option("--since-time <time>", "fetch meetings starting at or after this ISO 8601 date or time", date)
    .option("--lookback-days <days>", "revisit recent occurrences for late transcripts (0–31)", lookbackDays, 0)
    .action(async (opts: { sinceTime?: number; lookbackDays: number }, command: Command) => {
      if (!deps.source) throw new MeetingError("configuration_error", "meeting source is unavailable")
      print(
        await pull(deps.source, deps.store, {
          accountId: deps.accountId,
          since: opts.sinceTime === undefined ? undefined : new Date(opts.sinceTime).toISOString(),
          now: deps.now?.(),
          lookbackMs: opts.lookbackDays * 86400000,
        }),
        command,
      )
    })
  const importCommand = annotate(group.command("import"), {
    effects: LOCAL_WRITE,
    output: { entity: "meeting_ingestion" },
  })
    .description("import downloaded meeting transcripts")
    .argument("<folder>", "folder of transcripts downloaded from the provider")
  if (deps.importHelp) importCommand.addHelpText("after", `\n${deps.importHelp}`)
  output(importCommand).action(async (folder: string, _opts: unknown, command: Command) => {
    if (!deps.readFiles) throw new MeetingError("configuration_error", "file reader is unavailable")
    const files = await deps.readFiles(folder)
    if (files.some((file) => file.meeting.accountId !== deps.accountId))
      throw new MeetingError("validation_error", "file account differs from selected account")
    print(await importFiles(files, deps.store, deps.now?.()), command)
  })
  const eventList = queryWordsAfterOptions(
    annotate(program.command("events").description("the owner's stored events"), {
      effects: { remote: "none", local: "none" },
    }).command("list"),
  )
    .description("list stored events")
    .argument("[query...]", "event id, origin or time fields that narrow the list")
    .addHelpText("after", `\n${fieldsHelp(EVENT_QUERY, MEETING_QUERY_GUIDE)}`)
  annotate(eventList, { effects: LOCAL_READ, output: { entity: "event" }, query: EVENT_QUERY })
  output(eventList).action(async (words: string[], _opts: unknown, command: Command) => {
    const query = words.length
      ? parseLucene(words.join(" "), { defaultField: "none", command: "events list" })
      : undefined
    if (query) validateQuery(query, EVENT_QUERY, { command: "events list" })
    if (query && !deps.store.queryEvents) throw new MeetingError("validation_error", "this store cannot filter events")
    const events = query ? await deps.store.queryEvents?.(query) : await deps.store.events()
    print(listed((events ?? []).map(eventItem)), command)
  })
}

export {
  addMeetingPassageCommand,
  createMeetingPassageCommand,
  type MeetingPassageFlags,
  meetingPassageRequest,
} from "./passage.js"
export { addMeetingProjectEvidenceCommand } from "./project-evidence.js"
export { queryWordsAfterOptions } from "./query-options.js"
export {
  addMeetingSearchCommand,
  createMeetingSearchCommand,
  type MeetingHitSearch,
  type MeetingHitSearchOptions,
  type MeetingSearchFlags,
  meetingHitSearchRequest,
  meetingSearchArguments,
  meetingSearchMeta,
  validateMeetingHitSearch,
} from "./search.js"

export const addMeetingCommands = sharedCommand(addMeetingCommandsDefinition)
