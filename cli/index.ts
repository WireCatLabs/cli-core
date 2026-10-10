import { type Command, InvalidArgumentError } from "commander"
import { type ImportFile, importFiles } from "../import.js"
import { pull } from "../pull.js"
import { listed, MeetingError, meetingShow, meetingsList, meetingsSearch, meetingTranscript } from "../reads.js"
import type { MeetingSource } from "../source.js"
import type { MeetingStore } from "../store.js"

export interface MeetingCommandDeps {
  store: MeetingStore
  accountId: number
  source?: MeetingSource
  readFiles?: (folder: string) => Promise<ImportFile[]>
  write: (value: unknown, format: "json" | "jsonl" | "text") => void
  now?: () => number
}
const integer = (text: string) => {
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text)))
    throw new InvalidArgumentError("expected a positive integer")
  return Number(text)
}
const date = (text: string) => {
  if (!Number.isFinite(Date.parse(text))) throw new InvalidArgumentError("expected an ISO date or timestamp")
  return Date.parse(text)
}
export const addMeetingCommands = (program: Command, deps: MeetingCommandDeps): void => {
  const group = program.command("meetings").description("stored meetings and their records")
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
  output(group.command("list").description("list stored meetings"))
    .option("--since <date>", "meetings starting at or after this date", date)
    .option("--until <date>", "meetings starting at or before this date", date)
    .option("--limit <n>", "meetings per page", integer, 100)
    .option("--page <n>", "page number", integer, 1)
    .action(async (opts: { since?: number; until?: number; limit: number; page: number }, command: Command) => {
      print(
        await meetingsList(
          deps.store,
          { accountId: deps.accountId, since: opts.since, until: opts.until, limit: opts.limit },
          opts.page,
        ),
        command,
      )
    })
  output(
    group.command("show").description("show a stored meeting").argument("<meeting>", "stored meeting id", integer),
  ).action(async (id: number, _opts: unknown, command: Command) => {
    print(await meetingShow(deps.store, id, deps.accountId), command)
  })
  output(
    group
      .command("transcript")
      .description("show current meeting transcripts")
      .argument("<meeting>", "stored meeting id", integer),
  ).action(async (id: number, _opts: unknown, command: Command) => {
    print(await meetingTranscript(deps.store, id, deps.accountId), command)
  })
  output(
    group.command("search").description("search stored transcripts, chat and summaries").argument("<query>"),
  ).action(async (query: string, _opts: unknown, command: Command) => {
    print(await meetingsSearch(deps.store, query, { accountId: deps.accountId }), command)
  })
  output(group.command("people").description("find meeting participants by name or email").argument("<query>")).action(
    async (query: string, _opts: unknown, command: Command) => {
      print(listed(await deps.store.participants(query, deps.accountId)), command)
    },
  )
  output(group.command("pull").description("fetch meeting records from the connected account"))
    .option("--since <date>", "fetch occurrences starting at or after this date", date)
    .action(async (opts: { since?: number }, command: Command) => {
      if (!deps.source) throw new MeetingError("configuration_error", "meeting source is unavailable")
      print(
        await pull(deps.source, deps.store, {
          accountId: deps.accountId,
          since: opts.since === undefined ? undefined : new Date(opts.since).toISOString(),
          now: deps.now?.(),
        }),
        command,
      )
    })
  output(group.command("import").description("import downloaded meeting transcripts").argument("<folder>")).action(
    async (folder: string, _opts: unknown, command: Command) => {
      if (!deps.readFiles) throw new MeetingError("configuration_error", "file reader is unavailable")
      const files = await deps.readFiles(folder)
      if (files.some((file) => file.meeting.accountId !== deps.accountId))
        throw new MeetingError("validation_error", "file account differs from selected account")
      print(await importFiles(files, deps.store, deps.now?.()), command)
    },
  )
  output(
    program
      .command("events")
      .description("the owner's stored events")
      .command("list")
      .description("list stored events"),
  ).action(async (_opts: unknown, command: Command) => {
    print(listed(await deps.store.events()), command)
  })
}
