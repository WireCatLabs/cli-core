import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { Effects } from "@wirecat/cli-base/standards"
import { type Command, InvalidArgumentError, Option } from "commander"
import {
  type DeclaredMeetingFields,
  type ManagedMeeting,
  type ManagedMeetingChange,
  MEETING_FIELD_KEYS,
  MEETING_FIELDS,
  type MeetingManagement,
  type MeetingMutationReceipt,
  type MeetingSetting,
  meetingFieldFlag,
  SNAKE_CASE,
} from "../meeting-management.js"

const REMOTE_READ: Effects = { remote: "read", local: "read" }
const REMOTE_WRITE: Effects = { remote: "write", local: "write" }

interface ChangeFlags {
  title?: string
  kind?: "instant" | "scheduled"
  startTime?: string
  durationMinutes?: number
  timezone?: string
  agenda?: string
  setting?: [string, string][]
}

const minutes = (text: string) => {
  if (!/^[1-9]\d*$/.test(text)) throw new InvalidArgumentError("expected whole minutes")
  return Number(text)
}

const setting = (text: string, previous: [string, string][] = []): [string, string][] => {
  const at = text.indexOf("=")
  const name = text.slice(0, at)
  if (at < 1 || !SNAKE_CASE.test(name))
    throw new InvalidArgumentError("expected name=value with a snake_case name, such as access_type=trusted")
  return [...previous, [name, text.slice(at + 1)]]
}

const valuesOf = (one: MeetingSetting) =>
  one.type === "choice" ? one.values.join("|") : one.type === "boolean" ? "true|false" : "<text>"

/** The same options in every meetings tool; what this service takes is in `--setting`'s description and the help. */
const changeOptions = (command: Command, declared: DeclaredMeetingFields, create: boolean) => {
  const settings = declared.settings.length
    ? declared.settings.map((one) => `${one.name}=${valuesOf(one)}`).join(", ")
    : "this service has none"
  const takes = declared.fields.map(meetingFieldFlag).join(", ") || "none of the options above"
  const schedules = declared.fields.includes("startTime")
  const start = !create
    ? ""
    : !schedules
      ? "; this service takes none, its meetings start now"
      : declared.fields.includes("kind")
        ? "; for a meeting that starts now, give --kind instant instead"
        : ""
  return command
    .option("--title <title>", "the meeting's title")
    .addOption(new Option("--kind <kind>", "an instant or a scheduled meeting").choices(["instant", "scheduled"]))
    .option("--start-time <time>", `when it starts: an ISO time with its offset, 2026-11-20T10:00:00+01:00${start}`)
    .option("--duration-minutes <minutes>", "how long it lasts, 1–1440", minutes)
    .option("--timezone <zone>", "its IANA time zone, Europe/Madrid")
    .option("--agenda <text>", "its agenda")
    .option("--setting <name=value>", `a setting of this service; repeat it for more: ${settings}`, setting)
    .addHelpText(
      "after",
      [
        "",
        `This service takes ${takes}.`,
        ...(declared.settings.length
          ? ["Its settings:", ...declared.settings.map((one) => `  ${one.name}=${valuesOf(one)}  ${one.description}`)]
          : []),
      ].join("\n"),
    )
}

const changeOf = (flags: ChangeFlags): ManagedMeetingChange => {
  const change: ManagedMeetingChange = Object.fromEntries(
    MEETING_FIELDS.flatMap((key) => (flags[key] === undefined ? [] : [[key, flags[key]]])),
  )
  if (!flags.setting) return change
  const settings = new Map<string, string>()
  for (const [name, value] of flags.setting) {
    if (settings.has(name)) throw new CliError("validation_error", `--setting ${name} is given twice`)
    settings.set(name, value)
  }
  return { ...change, settings: Object.fromEntries(settings) }
}

const meetingOf = (one: ManagedMeeting) => ({
  id: one.id,
  title: one.title,
  kind: one.kind,
  start_time: one.startTime,
  duration_minutes: one.durationMinutes,
  timezone: one.timezone,
  agenda: one.agenda,
  join_url: one.joinUrl,
})

const receiptItem = (receipt: MeetingMutationReceipt) => {
  const { change } = receipt
  return {
    action: receipt.action,
    provider: receipt.scope.provider,
    account: receipt.scope.account,
    ...(receipt.id === undefined ? {} : { id: receipt.id }),
    ...(receipt.occurrenceId === undefined ? {} : { occurrence_id: receipt.occurrenceId }),
    ...(change
      ? {
          change: {
            ...Object.fromEntries(
              MEETING_FIELDS.flatMap((key) =>
                change[key] === undefined ? [] : [[MEETING_FIELD_KEYS[key], change[key]]],
              ),
            ),
            ...(change.settings === undefined ? {} : { settings: { ...change.settings } }),
          },
        }
      : {}),
    applied: receipt.applied,
    ...(receipt.meeting
      ? { meeting: meetingOf(receipt.meeting), untrusted: ["meeting.title", "meeting.agenda", "meeting.join_url"] }
      : {}),
  }
}

export interface MeetingManagementCommandDeps {
  management: MeetingManagement
  print: (value: unknown, command: Command) => void
  output: (command: Command) => Command
  inRun: <T>(command: Command, body: () => Promise<T>) => Promise<T>
  /** The profile's question before a write reaches the service (`MeetingCommandDeps.askFirst`). */
  askFirst?: (command: Command) => Promise<void>
}

/**
 * `meetings create|update|cancel|invitation` for a service that lets the owner change its meetings: each mounted only
 * where the host's ports have it. A write's key is its path (`meetings.create`), asked first by default; `--dry-run`
 * previews it without reaching the service.
 */
export const addMeetingManagementCommands = (group: Command, deps: MeetingManagementCommandDeps): void => {
  const { management, print, output, inRun, askFirst } = deps
  const has = (name: string) => management.capabilities.includes(name)
  // The question comes after validation, so a change the service cannot take is refused without asking. A write the
  // owner could not be asked about never goes: a host that forgets the question gets a refusal.
  const mutation = (command: Command) => ({
    apply: true,
    dryRun: command.optsWithGlobals().dryRun === true,
    confirm: async () => {
      if (!askFirst)
        throw new CliError("configuration_error", "this tool cannot ask before it changes a meeting on the service")
      await askFirst(command)
    },
  })
  const write = (name: string) =>
    annotate(group.command(name), { effects: REMOTE_WRITE, offline: false, output: { entity: "meeting_change" } })
  const target = (command: Command) => command.argument("<meeting>", "the service's id of the meeting")
  if (has("create"))
    output(
      changeOptions(write("create").description("create a meeting on the service"), management.fields.create, true),
    ).action(async (flags: ChangeFlags, command: Command) =>
      inRun(command, async () =>
        print({ item: receiptItem(await management.create(changeOf(flags), mutation(command))) }, command),
      ),
    )
  if (has("update"))
    output(
      changeOptions(
        target(write("update").description("change a meeting on the service")),
        management.fields.update,
        false,
      ),
    ).action(async (id: string, flags: ChangeFlags, command: Command) =>
      inRun(command, async () =>
        print({ item: receiptItem(await management.update(id, changeOf(flags), mutation(command))) }, command),
      ),
    )
  if (has("cancel"))
    output(
      target(write("cancel").description("cancel a meeting on the service")).option(
        "--occurrence-id <id>",
        "cancel only this occurrence of a repeating meeting",
      ),
    ).action(async (id: string, flags: { occurrenceId?: string }, command: Command) =>
      inRun(command, async () =>
        print(
          {
            item: receiptItem(
              await management.cancel(id, {
                ...mutation(command),
                ...(flags.occurrenceId === undefined ? {} : { occurrenceId: flags.occurrenceId }),
              }),
            ),
          },
          command,
        ),
      ),
    )
  if (has("invitation"))
    output(
      target(
        annotate(group.command("invitation"), {
          effects: REMOTE_READ,
          offline: false,
          output: { entity: "meeting_invitation" },
        }).description("the invitation text the service writes for a meeting"),
      ),
    ).action(async (id: string, _flags: unknown, command: Command) =>
      inRun(command, async () =>
        print({ item: { ...(await management.invitation(id)), untrusted: ["invitation"] } }, command),
      ),
    )
}
