import { CliError } from "@wirecat/cli-base"
import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import { timezoneOf } from "@wirecat/cli-base/query"
import type { Effects } from "@wirecat/cli-base/standards"
import { Argument, type Command, InvalidArgumentError } from "commander"
import { environmentOf, runBudgetOf } from "../../cli/context.js"
import { honoursDryRun } from "../../cli/dry-run-guard.js"
import { terminalAsker } from "../../cli/messenger/ask.js"
import { lineOf } from "../../cli/steps.js"
import type { EventStore } from "../../meetings/index.js"
import { searchEvents } from "../../services/events-search.js"
import { linkPeople } from "../../services/people.js"
import type { AccountKey, MessageStore } from "../../store/store.js"
import { BUSY_QUERY_HELP, busyAnswer, busyQuery, workingHoursOf } from "../busy.js"
import {
  CALENDAR_UNTRUSTED_FIELDS,
  calendarIn,
  calendarItem,
  EVENTS_QUERY_HELP,
  eventAnswer,
  eventIdOf,
  eventOf,
  eventsAnswer,
  eventsFilter,
  type PersonOfEmail,
  peopleAnswer,
  resolveAnswer,
  reviewsAnswer,
} from "../reads.js"
import { REPEAT_HELP } from "../recurrence.js"
import type { CalendarExpander, CalendarSource } from "../source.js"
import { calendarStatus, syncCalendars } from "../sync.js"
import type { EventResponse } from "../writer.js"
import {
  type CalendarWrites,
  createEvent,
  deleteEvent,
  EVENT_RESPONSES,
  type EventFields,
  moveEvent,
  respondToEvent,
  updateEvent,
  type WriteContext,
} from "../writes.js"

export interface CalendarCommandDeps {
  store: EventStore
  /** The selected profile's calendar account: every command reads and syncs only it. */
  accountId: number
  /** The same account as the shared store names it, for search and people. */
  account: AccountKey
  /** The profile's name, which `status` gives as each sync's `profile`. */
  profile?: string
  /** The shared store: `search`, `people link` and the person of an attendee read it. */
  messages?: MessageStore
  /** The provider; `sync` and `calendars list` read it. */
  source?: CalendarSource
  /**
   * The source answers `freeBusy`: mounts `calendars busy`. A flag rather than a look at `source`, which a CLI may
   * build only once a profile is open.
   */
  freeBusy?: boolean
  /** For a source with `expands: "local"`. */
  expand?: CalendarExpander
  /** After `sync --embed`: embeds new events for search by meaning (`embedEvents`), as drive's `sync --embed`. */
  embed?: (max: number) => Promise<unknown>
  write: (value: unknown, format: "json" | "jsonl" | "text") => void
  now?: () => number
  /** The zone `today`, `week` and a bare date are read in; the computer's when absent. */
  timezone?: string
  /** The provider's writer and the profile's guard: `events create|update|delete|respond` exist only with it. */
  writes?: CalendarWrites
}

const LOCAL_READ: Effects = { remote: "none", local: "read" }
const LOCAL_WRITE: Effects = { remote: "none", local: "write" }
const FETCH: Effects = { remote: "read", local: "write" }
const REMOTE_READ: Effects = { remote: "read", local: "none" }
const REMOTE_WRITE: Effects = { remote: "write", local: "write" }
const GROUP: Effects = { remote: "none", local: "none" }
/** How many pieces one `sync --embed` embeds, as drive's. */
const EMBED_MAX = 600

// A list's marker goes on each item: a host's list envelope is strict and `--jsonl` prints only the items.
const EVENT_ITEM_UNTRUSTED = ["title", "description", "location"]
const ATTENDEE_UNTRUSTED = ["name"]
const REVIEW_UNTRUSTED = ["candidates.title"]
const SEARCH_UNTRUSTED = ["hits.title", "hits.location", "hits.excerpt"]

const eachMarked = <T extends { items: object[] }>(answer: T, untrusted: string[]) => ({
  ...answer,
  items: answer.items.map((item) => ({ ...item, untrusted })),
})

const integer = (text: string) => {
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text)))
    throw new InvalidArgumentError("expected a positive integer")
  return Number(text)
}

const minutes = (text: string) => {
  const value = integer(text)
  if (value < 5 || value > 1440) throw new InvalidArgumentError("expected 5 to 1440 minutes")
  return value
}

const addCalendarCommandsDefinition = (program: Command, deps: CalendarCommandDeps): void => {
  const now = () => deps.now?.() ?? Date.now()
  const zone = () => timezoneOf(deps.timezone)
  const output = (command: Command) =>
    command
      .option("--json", "one JSON value")
      .option("--jsonl", "one JSON object per item")
      .hook("preAction", (cmd) => {
        const opts = cmd.optsWithGlobals()
        if (opts.json && opts.jsonl) throw new CliError("validation_error", "choose --json or --jsonl")
      })
  const print = (value: unknown, command: Command) => {
    const opts = command.optsWithGlobals()
    deps.write(value, opts.json ? "json" : opts.jsonl ? "jsonl" : "text")
  }
  const messages = (what: string) => {
    if (!deps.messages) throw new CliError("configuration_error", `${what} needs the shared store`)
    return deps.messages
  }
  const personOfEmail: PersonOfEmail | undefined = deps.messages
    ? async (email) => {
        const person = await messages("a person").people.personOf({ provider: "email", id: email })
        return person ? `person:${person.uid}` : null
      }
    : undefined
  const personId = async (reference: string): Promise<number | null> => {
    const text = reference.replace(/^person:/u, "")
    if (/^[1-9]\d*$/u.test(text)) return Number(text)
    const person = await messages("person:").people.personOf({ provider: "email", id: text.trim().toLowerCase() })
    return person ? Number(person.uid) : null
  }
  const example = (command: Command, ...lines: string[]) =>
    annotate(command, { examples: lines.map((line) => `${program.name()} personal ${line}`) })
  const source = () => {
    if (!deps.source) throw new CliError("configuration_error", "the calendar provider is unavailable")
    return deps.source
  }

  const calendars = annotate(program.command("calendars").description("the account's calendars"), { effects: GROUP })
  output(
    example(
      annotate(calendars.command("list"), { effects: FETCH, offline: false }).description(
        "list the account's calendars from the provider, and which of them sync",
      ),
      "calendars list --json",
    ),
  ).action(async (_opts: unknown, command: Command) => {
    const listed = await deps.store.saveCalendars(deps.accountId, await source().calendars(), now())
    print({ items: listed.map(calendarItem), page: 1, limit: listed.length, hasMore: false }, command)
  })
  for (const [name, synced] of [
    ["sync", true],
    ["unsync", false],
  ] as const)
    output(
      example(
        annotate(calendars.command(name), { effects: LOCAL_WRITE })
          .description(synced ? "sync this calendar from now on" : "stop syncing this calendar; what is stored stays")
          .argument("<calendar>", "the calendar's id, or the provider's id"),
        `calendars ${name} 3`,
      ),
    ).action(async (reference: string, _opts: unknown, command: Command) => {
      const calendar = await calendarIn(deps.store, deps.accountId, reference)
      await deps.store.setCalendarSynced(calendar.id, synced, now())
      print(calendarItem({ ...calendar, synced }), command)
    })

  if (deps.freeBusy)
    output(
      example(
        annotate(calendars.command("busy"), { effects: REMOTE_READ, offline: false })
          .description(
            "when calendars and people are taken, asked of the provider and not stored; with --duration-minutes, " +
              "the free stretches they share",
          )
          .argument("[words...]", "today, week, from:<date>, to:<date>, calendar:<id>, person:<email>")
          .addHelpText("after", BUSY_QUERY_HELP),
        "calendars busy week person:ana@example.com --json",
        "calendars busy from:2026-11-02 to:2026-11-06 person:ana@example.com --duration-minutes 30 --hours 10:00-16:00",
      ),
    )
      .option("--duration-minutes <minutes>", "find free stretches at least this long, 5–1440", minutes)
      .option(
        "--hours <from-to>",
        "working hours in your time zone, Monday to Friday, with --duration-minutes",
        "09:00-17:00",
      )
      .action(async (words: string[], opts: { durationMinutes?: number; hours: string }, command: Command) => {
        if (command.optsWithGlobals<{ offline?: boolean }>().offline)
          throw new CliError("permission_error", "calendars busy asks the provider; leave out --offline", {
            reason: "busy.offline",
          })
        const hours = workingHoursOf(opts.hours)
        const query = await busyQuery(words, { store: deps.store, accountId: deps.accountId, zone: zone(), now: now() })
        print(
          await busyAnswer(source(), query, {
            zone: zone(),
            now: now(),
            ...(opts.durationMinutes === undefined ? {} : { slot: { minutes: opts.durationMinutes, hours } }),
          }),
          command,
        )
      })

  output(
    example(
      annotate(program.command("sync"), {
        effects: FETCH,
        offline: false,
        cooperative: true,
        partial: true,
      }).description(
        "bring the synced calendars up to date: what changed since the last sync, or everything with --rescan; a run " +
          "stops before its deadline or --max-pages and the next one goes on from there",
      ),
      "sync",
      "sync --rescan --embed",
      "sync --timeout 2m",
    ),
  )
    .option("--rescan", "list every synced calendar's window again, dropping a round in progress")
    .option(
      "--max-pages <pages>",
      "at most this many requests to the provider in this run; as many as fit the deadline if not given",
      integer,
    )
    .option("--embed", "also index new events for meaning search, with a model already downloaded")
    .action(async (opts: { embed?: boolean; maxPages?: number; rescan?: boolean }, command: Command) => {
      // --full is the shared program's output flag; it used to start the round over here, and silently would not now.
      if (command.optsWithGlobals<{ full?: boolean }>().full)
        throw new CliError("validation_error", "sync starts over with --rescan; --full only widens output")
      const { signal } = environmentOf(command)
      const report = await syncCalendars(source(), deps.store, {
        accountId: deps.accountId,
        now: now(),
        budget: runBudgetOf(command, opts.maxPages),
        ...(signal ? { signal } : {}),
        ...(opts.rescan ? { full: true } : {}),
        ...(deps.expand ? { expand: deps.expand } : {}),
      })
      if (opts.embed && !deps.embed) throw new CliError("configuration_error", "this tool cannot embed events")
      // A run its budget stopped has no time left for the model; the run that finishes the round embeds.
      const embeddings = opts.embed && !report.stopped ? await deps.embed?.(EMBED_MAX) : undefined
      const timeout = command.optsWithGlobals<{ timeout?: string }>().timeout
      // The same command again, never --rescan: that would drop the round this run leaves in progress. A run that moved
      // nothing on would only repeat itself, so it gets no step an agent may run unasked.
      const stuck = report.state === "partial" && report.progress.steps === 0 && !report.synced.some((one) => one.error)
      const next =
        report.state === "partial" && !stuck && !report.synced.some((one) => one.error !== undefined)
          ? [
              {
                kind: "command" as const,
                step: "calendar.sync",
                command: "sync",
                args: Object.fromEntries(
                  Object.entries({ max_pages: opts.maxPages, timeout, embed: opts.embed }).filter(
                    ([, value]) => value !== undefined,
                  ),
                ),
                why: "the sync stopped before its end to answer in time; running it again goes on from where it stopped",
                safe_to_auto_execute: true,
              },
            ]
          : undefined
      const progressAt = lineOf(command, "status")
      report.hint = stuck
        ? `this run moved nothing on: raise --timeout or --max-pages, then run sync again; see progress: ${progressAt}`
        : report.state === "partial"
          ? `run sync again to continue; see progress: ${progressAt}`
          : report.hint
      if (report.hint === undefined) delete report.hint
      const failed = report.synced.filter((one) => one.error !== undefined)
      if (failed.length)
        // A failure prints nothing on stdout (WC-OUT-14), so the error carries every calendar's result.
        throw new CliError(
          "provider_error",
          `${failed.map((one) => `calendar ${one.calendarId} (${one.title ?? one.externalId}): ${one.error}`).join("; ")}` +
            " — run sync again to retry",
          {
            reason: "sync.partial",
            calendars: report.synced.map((one) => ({
              calendar_id: String(one.calendarId),
              external_id: one.externalId,
              title: one.title,
              round: one.round,
              state: one.state,
              saved: one.saved,
              removed: one.removed,
              occurrences: one.occurrences,
              ...(one.error === undefined ? {} : { error: one.error }),
            })),
            retryable: true,
            // A sync sends the provider no write, so running it again changes nothing there.
            sent: false,
          },
        )
      print({ ...report, ...(embeddings === undefined ? {} : { embeddings }), ...(next ? { next } : {}) }, command)
    })

  output(
    example(
      annotate(program.command("status"), { effects: LOCAL_READ }).description(
        "how far each synced calendar's sync is: entries done, partial or complete, and when it last moved",
      ),
      "status --json",
    ),
  ).action(async (_opts: unknown, command: Command) => {
    print(
      await calendarStatus(deps.store, deps.accountId, {
        profile: deps.profile ?? `account ${deps.accountId}`,
        now: now(),
      }),
      command,
    )
  })

  const events = annotate(program.command("events").description("the account's stored events"), { effects: GROUP })
  output(
    example(
      annotate(events.command("list"), { effects: LOCAL_READ, output: { entity: "event" } })
        .description("list stored events, earliest first")
        .argument("[words...]", "today, week, from:<date>, to:<date>, person:<who>, calendar:<id>")
        .addHelpText("after", EVENTS_QUERY_HELP),
      "events list week --json",
      "events list from:2026-11-02 to:2026-11-06 person:ana@example.com",
    ),
  )
    .option("--limit <n>", "events at most, 1–1000", integer, 100)
    .action(async (words: string[], opts: { limit: number }, command: Command) => {
      const filter = await eventsFilter(words, {
        store: deps.store,
        accountId: deps.accountId,
        zone: zone(),
        now: now(),
        personOf: personId,
      })
      print(
        eachMarked(await eventsAnswer(deps.store, filter && { ...filter, limit: opts.limit }), EVENT_ITEM_UNTRUSTED),
        command,
      )
    })
  output(
    example(
      annotate(events.command("show"), { effects: LOCAL_READ })
        .description("one event: its calendar copies, attendees with their person, Drive files and history")
        .argument("<event>", "the event's id, or event:<id>"),
      "events show event:42 --json",
    ),
  ).action(async (reference: string, _opts: unknown, command: Command) => {
    const shown = await eventAnswer(await eventOf(deps.store, deps.accountId, eventIdOf(reference)), personOfEmail)
    print({ ...shown, untrusted: CALENDAR_UNTRUSTED_FIELDS }, command)
  })

  output(
    example(
      annotate(program.command("search"), { effects: LOCAL_READ })
        .description("find stored events by words, and by meaning when its model is downloaded")
        .argument("<words...>", "what to find in titles, descriptions, places and attendees"),
      "search roadmap planning --json",
    ),
  )
    .option("--limit <n>", "events per page", integer, 20)
    .option("--cursor <cursor>", "continue from a page's next_offset", (text) => (text === "0" ? 0 : integer(text)), 0)
    .option("--exact", "every word as written, no word stems")
    .option("--newest", "latest start first instead of best first")
    .action(
      async (
        words: string[],
        opts: { limit: number; cursor: number; exact?: boolean; newest?: boolean },
        command: Command,
      ) => {
        const found = await searchEvents(messages("search"), words.join(" "), {
          accounts: [deps.account],
          limit: opts.limit,
          offset: opts.cursor,
          timezone: zone(),
          command: program.name(),
          ...(opts.exact ? { exact: true } : {}),
          ...(opts.newest ? { newest: true } : {}),
        })
        print({ ...found, untrusted: SEARCH_UNTRUSTED }, command)
      },
    )

  if (deps.writes) addEventWrites(events, deps.writes, { deps, now, zone, output, print, example })

  const people = annotate(program.command("people").description("the people in the account's events"), {
    effects: GROUP,
  })
  output(
    example(
      annotate(people.command("list"), { effects: LOCAL_READ })
        .description("one event's attendees, or everyone attending this week's events")
        .argument("[event]", "the event's id, or event:<id>"),
      "people list --json",
      "people list event:42",
    ),
  ).action(async (reference: string | undefined, _opts: unknown, command: Command) => {
    const event = reference === undefined ? undefined : eventIdOf(reference)
    const filter =
      event === undefined
        ? await eventsFilter(["week"], { store: deps.store, accountId: deps.accountId, zone: zone(), now: now() })
        : undefined
    const people = await peopleAnswer(deps.store, deps.accountId, {
      ...(event === undefined ? {} : { event }),
      ...(filter ? { filter } : {}),
      ...(personOfEmail ? { personOf: personOfEmail } : {}),
    })
    print(eachMarked(people, ATTENDEE_UNTRUSTED), command)
  })
  output(
    example(
      annotate(people.command("link"), { effects: LOCAL_WRITE })
        .description("join an attendee to a person the owner knows elsewhere")
        .argument("<person>", "an attendee's address as email:<address>, or a person:<id>")
        .argument("<other>", "the same person in another tool, as <provider>:<person>, or me"),
      "people link email:ana@example.com telegram:12345",
    ),
  ).action(async (person: string, other: string, _opts: unknown, command: Command) => {
    const linked = await linkPeople(messages("people link"), deps.account, person, other)
    print(
      {
        person: `person:${linked.uid}`,
        name: linked.name,
        identities: linked.identities.map(({ provider, id }) => `${provider}:${id}`),
      },
      command,
    )
  })

  const links = annotate(program.command("links").description("calendar copies the rules could not join alone"), {
    effects: GROUP,
  })
  output(
    example(
      annotate(links.command("review"), { effects: LOCAL_READ }).description(
        "copies that fit two or more events equally well, waiting for the owner's choice",
      ),
      "links review --json",
    ),
  ).action(async (_opts: unknown, command: Command) => {
    print(eachMarked(await reviewsAnswer(deps.store), REVIEW_UNTRUSTED), command)
  })
  output(
    example(
      annotate(links.command("resolve"), { effects: LOCAL_WRITE })
        .description("join a copy to the event you choose, or keep it apart")
        .argument("<review>", "the review's id from links review")
        .argument("<choice>", "one of its candidates, as event:<id>, or apart"),
      "links resolve 7 event:42",
    ),
  ).action(async (review: string, choice: string, _opts: unknown, command: Command) => {
    print(await resolveAnswer(deps.store, deps.accountId, review, choice, now()), command)
  })
}

interface WriteHelpers {
  deps: CalendarCommandDeps
  now: () => number
  zone: () => string
  output: (command: Command) => Command
  print: (value: unknown, command: Command) => void
  example: (command: Command, ...lines: string[]) => Command
}

const collect = (value: string, previous: string[] = []) => [...previous, value]

const addEventWrites = (
  events: Command,
  writes: CalendarWrites,
  { deps, now, zone, output, print, example }: WriteHelpers,
) => {
  const context = (command: Command): WriteContext => ({
    store: deps.store,
    accountId: deps.accountId,
    writes,
    ask: terminalAsker(command),
    now: now(),
    zone: zone(),
    names: {
      notify: "--notify or --no-notify",
      id: "--id",
      calendar: "--calendar",
      series: "--series",
      following: "--following",
      repeat: "--repeat",
    },
  })
  const printWritten = (value: object, command: Command) =>
    print({ ...value, untrusted: CALENDAR_UNTRUSTED_FIELDS }, command)
  // Left out on purpose: with other attendees the owner must choose, so neither switch is the default.
  const notify = (command: Command) =>
    command
      .option(
        "--notify",
        "the provider mails the other attendees; needs events.notify allowed; this or --no-notify is required " +
          "when there are other attendees",
      )
      .option("--no-notify", "the provider mails nobody")
  const fields = (command: Command, replacing: boolean) =>
    command
      .option("--title <title>", "the event's title")
      .option("--start-time <time>", "when it starts: a time in your zone, or one with its own")
      .option("--end-time <time>", "when it ends")
      .option("--start-date <date>", "the first day of an all-day event, YYYY-MM-DD")
      .option("--end-date <date>", "the last day of an all-day event")
      .option("--location <text>", "where; empty clears it")
      .option("--description <text>", "the details; empty clears it")
      // The empty default marks the flag as repeatable, so an agent's tool takes a list; empty is "not given".
      .option(
        "--attendee <email>",
        `an attendee; repeat for each${replacing ? ", replacing the list" : ""}`,
        collect,
        [] as string[],
      )
      .option("--repeat <rule>", `how it repeats${replacing ? ", with --series" : ""}: ${REPEAT_HELP}`)
  type FieldOptions = Omit<EventFields, "attendees"> & { attendee?: string[] }
  const fieldsOf = ({ attendee, ...given }: FieldOptions): EventFields => ({
    ...Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined)),
    ...(attendee === undefined || attendee.length === 0 ? {} : { attendees: attendee }),
  })
  type Choices = { calendar?: string; series?: boolean; following?: boolean; notify?: boolean }
  const choicesOf = ({ calendar, series, following, notify }: Choices) => ({
    ...(calendar === undefined ? {} : { calendar }),
    ...(series ? { series: true } : {}),
    ...(following ? { following: true } : {}),
    ...(notify === undefined ? {} : { notify }),
  })
  const write = (name: string) => annotate(events.command(name), { effects: REMOTE_WRITE, offline: false })
  const target = (command: Command) =>
    command
      .argument("<event>", "the event's id, or event:<id>")
      .option("--calendar <id>", "the calendar, when the event is on more than one of the account's")

  output(
    example(
      notify(
        fields(write("create"), false)
          .description("add an event to a calendar; with --repeat, one that repeats")
          .argument("<calendar>", "the calendar's id, or the provider's id"),
      ).option("--id <id>", "the id a create that ended in outcome_unknown named: a retry finds that event"),
      "events create 3 --title 'Example planning' --start-time 2026-11-02T10:00 --end-time 2026-11-02T11:00",
      "events create 3 --title 'Example review' --start-date 2026-11-03 --end-date 2026-11-03 " +
        "--attendee ana@example.com --no-notify",
      "events create 3 --title 'Example standup' --start-time 2026-11-02T09:30 --end-time 2026-11-02T09:45 " +
        "--repeat 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=12'",
    ),
  ).action(async (calendar: string, opts: FieldOptions & Choices & { id?: string }, command: Command) => {
    const { notify: choice, id, ...rest } = opts
    printWritten(
      await createEvent(context(command), calendar, fieldsOf(rest), {
        ...(choice === undefined ? {} : { notify: choice }),
        ...(id === undefined ? {} : { id }),
      }),
      command,
    )
  })
  output(
    example(
      notify(
        target(fields(write("update"), true))
          .description(
            "change an event; with --series every occurrence of the repeating event, with --following this " +
              "occurrence and every later one; new times or dates switch it between timed and all-day",
          )
          .option("--series", "change the whole repeating event, not only this occurrence")
          .option(
            "--following",
            "change this occurrence and every later one: the repeating event ends before it and a new one starts " +
              "with the change",
          )
          .option("--id <id>", "with --following, the id an outcome_unknown named: a retry finds that new series"),
      ),
      "events update event:42 --start-time 2026-11-02T14:00 --end-time 2026-11-02T15:00 --notify",
      "events update event:42 --series --repeat 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231T230000Z' --no-notify",
      "events update event:42 --following --start-time 2026-11-09T10:00 --end-time 2026-11-09T10:30 --no-notify",
    ),
  ).action(async (reference: string, opts: FieldOptions & Choices & { id?: string }, command: Command) => {
    const { calendar: _calendar, series: _series, following: _following, notify: _notify, id, ...rest } = opts
    printWritten(
      await updateEvent(context(command), reference, fieldsOf(rest), {
        ...choicesOf(opts),
        ...(id === undefined ? {} : { id }),
      }),
      command,
    )
  })
  output(
    example(
      notify(
        target(write("delete"))
          .description(
            "delete an event; a whole repeating event, or every later occurrence, needs events.delete.series " +
              "allowed first",
          )
          .option("--series", "delete the whole repeating event, not only this occurrence")
          .option("--following", "delete this occurrence and every later one: the repeating event ends before it"),
      ),
      "events delete event:42 --no-notify",
      "events delete event:42 --following --no-notify",
    ),
  ).action(async (reference: string, opts: Choices, command: Command) => {
    printWritten(await deleteEvent(context(command), reference, choicesOf(opts)), command)
  })
  if (writes.writer.move)
    output(
      example(
        notify(
          target(write("move"))
            .description("move an event, with its id, to another calendar of the account; a repeating one moves whole")
            .requiredOption("--to-calendar <id>", "the calendar to move it to: its id, or the provider's id")
            .option("--series", "move the whole repeating event an occurrence belongs to"),
        ),
        "events move event:42 --to-calendar 4 --no-notify",
      ),
    ).action(async (reference: string, opts: Choices & { toCalendar: string }, command: Command) => {
      const { series, calendar, notify } = opts
      printWritten(
        await moveEvent(context(command), reference, opts.toCalendar, choicesOf({ series, calendar, notify })),
        command,
      )
    })
  output(
    example(
      notify(
        target(write("respond"))
          .description("answer an invitation; the organiser is told only with --notify")
          .addArgument(new Argument("<response>", "the answer").choices(EVENT_RESPONSES)),
      ),
      "events respond event:42 accepted --notify",
    ),
  ).action(async (reference: string, response: EventResponse, opts: Choices, command: Command) => {
    printWritten(await respondToEvent(context(command), reference, response, choicesOf(opts)), command)
  })
}

// honoursDryRun: a host program other than `run` would otherwise let a write through under --dry-run.
export const addCalendarCommands = honoursDryRun(sharedCommand(addCalendarCommandsDefinition))
