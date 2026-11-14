import { annotate, annotateOption, sharedCommand } from "@wirecat/cli-base/commands"
import { defineQuery, fieldsHelp, parseLucene, timezoneOf, validateQuery } from "@wirecat/cli-base/query"
import type { Effects } from "@wirecat/cli-base/standards"
import { type Command, InvalidArgumentError, Option } from "commander"
import { dateWindow } from "../../services/moment.js"
import { EVENT_QUERY } from "../event-query.js"
import { exportMeeting, type MeetingExportFormat } from "../export.js"
import { type ImportFile, importFiles } from "../import.js"
import { BACKENDS, type Backend } from "../index.js"
import { MEETING_QUERY } from "../item.js"
import type { MeetingManagement } from "../meeting-management.js"
import type { MeetingParticipantSearchOptions } from "../participant-search.js"
import { type MeetingBudget, pull } from "../pull.js"
import { eventItem } from "../read-answers.js"
import { type MeetingServerAccess, meetingShowThrough, meetingsListThrough } from "../read-through.js"
import {
  listed,
  MEETING_QUERY_GUIDE,
  MeetingError,
  meetingDetailsBody,
  meetingPeople,
  meetingSummaryAnswer,
  meetingsQuery,
  meetingTranscriptAnswer,
} from "../reads.js"
import { SAVE_HELP } from "../save-hints.js"
import type { MeetingSource } from "../source.js"
import type { MeetingStore } from "../store.js"
import { addMeetingManagementCommands } from "./management.js"
import { queryWordsAfterOptions } from "./query-options.js"

export interface MeetingCommandDeps {
  store: MeetingStore
  accountId: number
  source?: MeetingSource
  readFiles?: (folder: string) => Promise<ImportFile[]>
  /** The host's file names and how it reads their time, shown in `meetings import --help`. */
  importHelp?: string
  /** Writes `meetings export --output`; one that refuses a file that exists, such as `writeNewFile`. */
  writeFile?: (path: string, content: string) => Promise<void>
  /**
   * Marks `meetings export`, whose only write is the new file `--output` names: a read without it, over MCP, and
   * under the read-only lock. `writesNewFileOnlyWith` from `@wirecat/cli-core/cli`; pass it with a `writeFile` that
   * never writes over a file.
   */
  newFileOutput?: (command: Command, option: string) => void
  write: (value: unknown, format: "json" | "jsonl" | "text") => void
  /**
   * Runs a command that reaches the account inside cli-core's run, so it is recorded and ended by `--timeout`:
   * `inCommandRun` from `@wirecat/cli-core/cli`. Required, since this module cannot reach the run itself.
   */
  inRun: <T>(command: Command, body: () => Promise<T>) => Promise<T>
  /**
   * The sync's budget from the run's deadline and stop signal: `runBudgetOf` from `@wirecat/cli-core/cli`. Given, the
   * sync is cooperative: it stops between meetings, keeps what it saved and answers `stopped`. Without it the sync
   * keeps the one-shot deadline.
   */
  budgetOf?: (command: Command) => MeetingBudget
  /**
   * `meetings list`'s page from its flags and the profile's `defaults.limit`: `pagingOf` from `@wirecat/cli-core/cli`.
   * Required, since this module cannot reach the profile's settings itself.
   */
  pagingOf: (command: Command) => { limit: number; page: number }
  now?: () => number
  /** The owner's zone, in which `meetings list` reads a query's dates on both sides; the computer's without it. */
  timezone?: string
  /**
   * The service's meeting writes, `createMeetingManagement(scope, ports)`: `meetings create|update|cancel|invitation`
   * are mounted for the ports it has.
   */
  management?: MeetingManagement
  /**
   * Puts the profile's question before a write to the service: `askBeforeWrite` from `@wirecat/cli-core/cli`, which
   * asks when the command's key is at `ask` and refuses when nobody can answer. Without it the writes refuse.
   */
  askFirst?: (command: Command) => Promise<void>
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
const LOCAL_READ: Effects = { remote: "none", local: "read" }
/** Reads the service; what it returns is kept as `sync` keeps it, which counts as a read (WC-CMD-17). */
const REMOTE_READ: Effects = { remote: "read", local: "read" }
const backendOf = (value: string): Backend => {
  if (!(BACKENDS as readonly string[]).includes(value))
    throw new InvalidArgumentError("expected archive, server or both")
  return value as Backend
}
// No commander default: an untyped --backend falls back to the store with a `missing` line, a typed one refuses.
const backendOption = (command: Command) =>
  command.option(
    "--backend <archive|server|both>",
    "where to read: the store (archive), the service (server), or both, kept in the store (default: both)",
    backendOf,
  )
const BACKEND_HELP =
  "--backend both asks the service with the part of the query it can filter, keeps what it returns, then runs the " +
  "whole query over the store; each item says found_in archive, server or both. --offline reads the store only."
const LOCAL_WRITE: Effects = { remote: "none", local: "write" }
const FETCH: Effects = { remote: "read", local: "write" }

const addMeetingCommandsDefinition = (program: Command, deps: MeetingCommandDeps): void => {
  const group = annotate(program.command("meetings").description("stored meetings and their records"), {
    effects: { remote: "none", local: "none" },
  })
  // The host's root gives `--json [fields]` and `--jsonl`; a leaf of its own would shadow them.
  const output = (command: Command) => command
  const print = (value: unknown, command: Command) => {
    const opts = command.optsWithGlobals()
    deps.write(value, opts.json ? "json" : opts.jsonl ? "jsonl" : "text")
  }
  const access = (command: Command, backend: Backend | undefined): MeetingServerAccess => ({
    ...(backend === undefined ? {} : { backend }),
    offline: command.optsWithGlobals().offline === true,
    timezone: timezoneOf(deps.timezone),
    ...(deps.now ? { now: deps.now() } : {}),
  })
  const list = queryWordsAfterOptions(
    group.command("list").description("meetings, newest first: the service's and the stored ones, kept in the store"),
  )
    .argument("[query...]", "field:value terms that narrow the list — the fields are below")
    .addHelpText("after", `\n${fieldsHelp(MEETING_QUERY, MEETING_QUERY_GUIDE)}\n${BACKEND_HELP}`)
  annotate(list, {
    effects: REMOTE_READ,
    partial: true,
    query: defineQuery(MEETING_QUERY),
    output: { entity: "meeting" },
  })
  backendOption(output(list))
    .option("--limit <n>", "meetings per page; the profile's defaults.limit when absent", integer)
    .option("--page <n>", "which page, starting at 1", integer)
    .action(async (words: string[], opts: { backend?: Backend }, command: Command) => {
      const query = meetingsQuery(words.join(" "))
      const { limit, page } = deps.pagingOf(command)
      await deps.inRun(command, async () => {
        // The standard envelope has no place for the counts; what the reader must know is in `missing` and `meta`.
        const { server: _server, ...answer } = await meetingsListThrough(
          deps.source,
          deps.store,
          {
            accountId: deps.accountId,
            limit,
            offset: (page - 1) * limit,
            ...(query ? { query } : {}),
          },
          access(command, opts.backend),
        )
        print(answer, command)
      })
    })
  backendOption(
    output(
      annotate(group.command("show"), { effects: REMOTE_READ, partial: true, output: { entity: "meeting_details" } })
        .description("show a meeting, read again from the service with its people, transcript and documents")
        .argument("<meeting>", "the stored meeting's number, its meeting: ref, or the service's id (provider_id)")
        .addHelpText("after", `${SAVE_HELP}\n${BACKEND_HELP}`),
    ),
  ).action(async (meeting: string, opts: { backend?: Backend }, command: Command) => {
    await deps.inRun(command, async () => {
      const shown = await meetingShowThrough(
        deps.source,
        deps.store,
        deps.accountId,
        meeting,
        access(command, opts.backend),
      )
      const { item } = await meetingDetailsBody(deps.store, shown.details)
      print(
        {
          item: shown.foundIn ? { ...item, found_in: shown.foundIn } : item,
          ...(shown.missing ? { missing: shown.missing } : {}),
          ...(shown.meta ? { meta: shown.meta } : {}),
        },
        command,
      )
    })
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
  const exporter = output(
    annotate(group.command("export"), { effects: LOCAL_WRITE, output: { entity: "meeting_export" } })
      .description("export a meeting as Markdown or one transcript as WebVTT")
      .argument("<meeting>", "stored meeting id", integer)
      .addOption(new Option("--format <format>", "export format").choices(["markdown", "vtt"]).default("markdown"))
      .option("--transcript-id <id>", "export a specific transcript version", integer)
      .addOption(
        // Not over MCP: an agent would choose where on the owner's disk to write; it gets the content in the answer.
        annotateOption(new Option("--output <file>", "write content to a new file through the host's writer"), {
          mcp: false,
        }),
      ),
  )
  deps.newFileOutput?.(exporter, "output")
  exporter.action(
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
      // Only a sync that stops itself at its budget may outlive the one-shot deadline.
      ...(deps.budgetOf ? { cooperative: true, partial: true } : {}),
    }).description(
      "bring the stored meetings up to date from the connected account, oldest first; a run that stops before its " +
        "deadline keeps what it saved and the next one goes on from there",
    ),
  )
    .option(
      "--since-time <time>",
      "fetch meetings starting at or after this ISO 8601 date or time, or 30m, 2h, 7d ago",
      (text: string) =>
        dateWindow({ sinceTime: text, ...(deps.timezone ? { zone: deps.timezone } : {}), now: deps.now?.() }).since,
    )
    .option("--lookback-days <days>", "revisit recent occurrences for late transcripts (0–31)", lookbackDays)
    .option("--rescan", "read the last 30 days again, not only what came after the last sync")
    .action(async (opts: { sinceTime?: number; lookbackDays?: number; rescan?: boolean }, command: Command) => {
      const source = deps.source
      if (!source) throw new MeetingError("configuration_error", "meeting source is unavailable")
      await deps.inRun(command, async () =>
        print(
          await pull(source, deps.store, {
            accountId: deps.accountId,
            since: opts.sinceTime === undefined ? undefined : new Date(opts.sinceTime).toISOString(),
            now: deps.now?.(),
            ...(opts.lookbackDays === undefined ? {} : { lookbackMs: opts.lookbackDays * 86400000 }),
            ...(opts.rescan ? { rescan: true } : {}),
            ...(deps.budgetOf ? { budget: deps.budgetOf(command) } : {}),
          }),
          command,
        ),
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
  output(
    annotate(group.command("repair"), {
      effects: LOCAL_WRITE,
      output: { entity: "meeting_repair" },
    }).description(
      "preview filling in what older builds left out of stored transcripts (their language); --yes stores it",
    ),
  )
    .option("--yes", "store the detected languages; otherwise only preview")
    .action(async (opts: { yes?: boolean }, command: Command) => {
      if (!deps.store.fillTranscriptLanguages)
        throw new MeetingError("configuration_error", "this store cannot fill transcript languages")
      print(
        await deps.store.fillTranscriptLanguages({
          accountId: deps.accountId,
          apply: opts.yes === true,
          now: deps.now?.() ?? Date.now(),
        }),
        command,
      )
    })
  if (deps.management)
    addMeetingManagementCommands(group, {
      management: deps.management,
      print,
      output,
      inRun: deps.inRun,
      ...(deps.askFirst ? { askFirst: deps.askFirst } : {}),
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
