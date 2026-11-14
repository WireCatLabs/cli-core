import { CliError } from "@wirecat/cli-base"
import { annotate } from "@wirecat/cli-base/commands"
import type { Effects } from "@wirecat/cli-base/standards"
import { type Command, InvalidArgumentError, Option } from "commander"
import type {
  ManagedMeeting,
  ManagedMeetingChange,
  MeetingManagement,
  MeetingMutationReceipt,
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
}

const minutes = (text: string) => {
  if (!/^[1-9]\d*$/.test(text)) throw new InvalidArgumentError("expected whole minutes")
  return Number(text)
}

const changeOptions = (command: Command) =>
  command
    .option("--title <title>", "the meeting's title")
    .addOption(new Option("--kind <kind>", "an instant or a scheduled meeting").choices(["instant", "scheduled"]))
    .option("--start-time <time>", "when it starts: an ISO time with its offset, 2026-11-20T10:00:00+01:00")
    .option("--duration-minutes <minutes>", "how long it lasts, 1–1440", minutes)
    .option("--timezone <zone>", "its IANA time zone, Europe/Madrid")
    .option("--agenda <text>", "its agenda")

const changeOf = (flags: ChangeFlags): ManagedMeetingChange =>
  Object.fromEntries(
    (["title", "kind", "startTime", "durationMinutes", "timezone", "agenda"] as const).flatMap((key) =>
      flags[key] === undefined ? [] : [[key, flags[key]]],
    ),
  )

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
            ...(change.title === undefined ? {} : { title: change.title }),
            ...(change.kind === undefined ? {} : { kind: change.kind }),
            ...(change.startTime === undefined ? {} : { start_time: change.startTime }),
            ...(change.durationMinutes === undefined ? {} : { duration_minutes: change.durationMinutes }),
            ...(change.timezone === undefined ? {} : { timezone: change.timezone }),
            ...(change.agenda === undefined ? {} : { agenda: change.agenda }),
          },
        }
      : {}),
    applied: receipt.applied,
    ...(receipt.meeting ? { meeting: meetingOf(receipt.meeting) } : {}),
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
  // A write the owner could not be asked about never goes: a host that forgets the question gets a refusal.
  const mutation = async (command: Command) => {
    const dryRun = command.optsWithGlobals().dryRun === true
    if (!dryRun) {
      if (!askFirst)
        throw new CliError("configuration_error", "this tool cannot ask before it changes a meeting on the service")
      await askFirst(command)
    }
    return { apply: true, dryRun }
  }
  const write = (name: string) =>
    annotate(group.command(name), { effects: REMOTE_WRITE, offline: false, output: { entity: "meeting_change" } })
  const target = (command: Command) => command.argument("<meeting>", "the service's id of the meeting")
  if (has("create"))
    output(changeOptions(write("create").description("create a meeting on the service"))).action(
      async (flags: ChangeFlags, command: Command) =>
        inRun(command, async () =>
          print({ item: receiptItem(await management.create(changeOf(flags), await mutation(command))) }, command),
        ),
    )
  if (has("update"))
    output(changeOptions(target(write("update").description("change a meeting on the service")))).action(
      async (id: string, flags: ChangeFlags, command: Command) =>
        inRun(command, async () =>
          print({ item: receiptItem(await management.update(id, changeOf(flags), await mutation(command))) }, command),
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
                ...(await mutation(command)),
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
