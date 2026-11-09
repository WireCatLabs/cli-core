import { CliError } from "@wirecat/cli-base"
import { annotate, metaOf, sharedCommand } from "@wirecat/cli-base/commands"
import { timezoneOf } from "@wirecat/cli-base/query"
import { clockMeta, type Effects, type NextStep } from "@wirecat/cli-base/standards"
import { Argument, type Command, InvalidArgumentError, Option } from "commander"
import { environmentOf, inCommandRun, outputFor, runBudgetOf } from "../../cli/context.js"
import { honoursDryRun } from "../../cli/dry-run-guard.js"
import { changesStore, ownerOnlyOption, writesFileOnlyWith } from "../../cli/effects.js"
import { type Body, renderAnswer } from "../../cli/envelope.js"
import { queryTerms, withQuery } from "../../cli/list-query.js"
import { terminalAsker } from "../../cli/messenger/ask.js"
import { lineOf } from "../../cli/steps.js"
import type { EventStore } from "../../meetings/index.js"
import type { AppIdentity } from "../../ports/app.js"
import { secretInput } from "../../runs/run-context.js"
import { searchEvents } from "../../services/events-search.js"
import { dateWindow } from "../../services/moment.js"
import { embedEvents } from "../../services/notes-search.js"
import type { AccountKey, MessageStore } from "../../store/store.js"
import { BUSY_QUERY, BUSY_QUERY_NOTE, busyAnswer, busyQuery, workingHoursOf } from "../busy.js"
import { type CalendarFeeds, isFeedCalendar, isPlainHttp, syncWithFeeds } from "../feeds.js"
import { eventPreparation, nextMeeting, PREPARE_MESSAGES } from "../prepare.js"
import {
  accountsMeta,
  CALENDAR_UNTRUSTED_FIELDS,
  calendarAccountNames,
  calendarIn,
  calendarItem,
  EVENTS_QUERY,
  EVENTS_QUERY_NOTE,
  EXPORT_MAX,
  eventAnswer,
  eventIdOf,
  eventOf,
  eventsAnswer,
  eventsFilter,
  eventsIcs,
  type PersonOfEmail,
  peopleAnswer,
  type ReadAccount,
  resolveAnswer,
  reviewsAnswer,
  sourceAccounts,
  weekFilter,
} from "../reads.js"
import { REPEAT_HELP } from "../recurrence.js"
import { bothSearchAnswer, serverSearchAnswer } from "../server-search.js"
import type { CalendarExpander, CalendarSource } from "../source.js"
import { calendarStatus } from "../sync.js"
import type { EventResponse } from "../writer.js"
import {
  type CalendarWrites,
  createEvent,
  createEventFromText,
  deleteEvent,
  EVENT_RESPONSES,
  type EventFields,
  IMPORT_MAX,
  importEvents,
  moveEvent,
  respondToEvent,
  updateEvent,
  type WriteContext,
} from "../writes.js"
import { CALENDARS_QUERY, declareCalendarAnswers, PEOPLE_QUERY } from "./answers.js"
import { hitsBody, itemBody, listBody, messagesOf, pathOf } from "./bodies.js"
import { ICS_MAX_BYTES, readIcsFile, writeIcsFile } from "./files.js"
import { localTimesView } from "./local-times.js"
import { addPeopleLink } from "./people-link.js"
import { addRemind } from "./remind.js"
import { addSearchAll } from "./search-all.js"

/**
 * The selected profile's calendar, opened by the app for one command and closed once its answer is built, before
 * anything is printed (WC-LIFE-4). Nothing of it outlives the command, so concurrent runs share no state (WC-ARCH-22).
 */
export interface CalendarRun {
  /** The profile's name, which `store status` gives as each sync's `profile`. */
  profile: string
  /** The profile's calendar account as the shared store names it: every command reads and syncs only it. */
  account: AccountKey
  accountId: number
  store: EventStore
  /** The shared store: `search`, `people link`, `--source` and an attendee's person read it. */
  messages?: MessageStore
  /** The provider, built on first use: a command that only reads the store never reads the sign-in. */
  source: () => CalendarSource
  /** The provider's writer and the profile's guard, for the write commands. */
  writes?: () => CalendarWrites
  /** The iCalendar feeds the profile follows; `sync` and `calendars list` read them after the provider. */
  feeds?: () => CalendarFeeds
  /** For a source with `expands: "local"`. */
  expand?: CalendarExpander
  env?: NodeJS.ProcessEnv
  /**
   * A profile lock pins the process (WC-ACCT-5): `events list --source` may then read only the profile's account, and
   * `links review` lists only its choices.
   */
  locked?: boolean
  close?: () => Promise<void>
}

/** What the provider can do, known when the commands are built, before any profile is open. */
export interface CalendarCommandOptions {
  /** The CLI itself: the first word of examples, the store's command name, and `search all`. */
  app: AppIdentity
  /**
   * Opens the selected profile's calendar for one command. `readOnly` is true when the command only reads the store, so
   * parallel reads take no write lock; the app may still open it writable, for a profile's first run say.
   */
  open: (command: Command, access: { readOnly: boolean }) => Promise<CalendarRun>
  /** The source answers `freeBusy`: mounts `calendars busy`. */
  freeBusy?: boolean
  /** The source answers `search`: `search events` takes `--backend server|both`. */
  serverSearch?: boolean
  /** The profile may follow iCalendar feeds: mounts `calendars add|remove`. */
  feeds?: boolean
  /** The provider takes writes: mounts `events create|update|delete|respond|remind`, and what its writer adds. */
  writes?: { quickAdd?: boolean; move?: boolean; importEvent?: boolean }
  /** Reads `events import`'s file; a file on disk, at most 10 MB, when absent. */
  readFile?: (path: string) => Promise<string>
  /** Writes `events export --output`'s file; owner-only (0600), whole or not at all, when absent. */
  writeFile?: (path: string, content: string) => Promise<void>
  now?: () => number
  /** The zone `today`, `week` and a bare date are read in; the computer's when absent. */
  timezone?: string
}

const LOCAL_READ: Effects = { remote: "none", local: "read" }
const LOCAL_WRITE: Effects = { remote: "none", local: "write" }
const FETCH: Effects = { remote: "read", local: "write" }
const REMOTE_READ: Effects = { remote: "read", local: "none" }
const LOCAL_OR_REMOTE_READ: Effects = { remote: "read", local: "read" }
const REMOTE_WRITE: Effects = { remote: "write", local: "write" }
const GROUP: Effects = { remote: "none", local: "none" }
/** How many pieces one `sync --embed` embeds, as drive's. */
const EMBED_MAX = 600

// A list's marker goes on each item: a host's list envelope is strict and `--jsonl` prints only the items.
const EVENT_ITEM_UNTRUSTED = ["title", "description", "location"]
const ATTENDEE_UNTRUSTED = ["name"]
const REVIEW_UNTRUSTED = ["candidates.title"]
const SEARCH_UNTRUSTED = ["hits.title", "hits.location", "hits.excerpt"]
const SERVER_SEARCH_UNTRUSTED = ["hits.title", "hits.location"]
const IMPORT_UNTRUSTED = ["imported.uid", "imported.entry.title", "skipped.uid", "skipped.reason"]

const eachMarked = <T extends { items: object[] }>(answer: T, untrusted: string[]) => ({
  ...answer,
  items: answer.items.map((item) => ({ ...item, untrusted })),
})

const integer = (text: string) => {
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text)))
    throw new InvalidArgumentError("expected a positive integer")
  return Number(text)
}

const upTo = (most: number) => (text: string) => {
  const value = integer(text)
  if (value > most) throw new InvalidArgumentError(`expected 1 to ${most}`)
  return value
}

const minutes = (text: string) => {
  const value = integer(text)
  if (value < 5 || value > 1440) throw new InvalidArgumentError("expected 5 to 1440 minutes")
  return value
}

/** A search tops up its pending word index before it answers, which is a write; every other read only reads. */
const readsOnly = (command: Command): boolean =>
  metaOf(command).effects?.local !== "write" && pathOf(command)[0] !== "search"

const addCalendarCommandsDefinition = (program: Command, options: CalendarCommandOptions): void => {
  const mounted = new Set(program.commands)
  const now = () => options.now?.() ?? Date.now()
  const zone = () => timezoneOf(options.timezone)
  const answer = (command: Command, body: Body, view?: (body: Body) => string) => {
    const output = outputFor(command)
    renderAnswer(command, output, body, view ?? ((shown) => localTimesView(shown, zone(), output.color)))
  }
  /** Opens the profile for `work` and closes it before the answer prints, also when `work` fails. */
  const within: Within = (command, work, view) =>
    inCommandRun(command, async () => {
      const run = await options.open(command, { readOnly: readsOnly(command) })
      answer(command, await work(run).finally(() => run.close?.()), view)
    })
  const example = (command: Command, ...lines: string[]) =>
    annotate(command, { examples: lines.map((line) => `${options.app.command} personal ${line}`) })

  const calendars = annotate(program.command("calendars").description("the account's calendars"), { effects: GROUP })
  withQuery(
    example(
      annotate(calendars.command("list"), { effects: FETCH, offline: false }).description(
        "list the account's calendars from the provider, and which of them sync",
      ),
      "calendars list --json",
      "calendars list synced:true",
    ),
    CALENDARS_QUERY,
  ).action(async (words: string[], _opts: unknown, command: Command) => {
    const terms = [...queryTerms(words, CALENDARS_QUERY, "calendars list")]
    await within(command, async (run) => {
      // WC-CMD-20: the provider's list has no filter for these terms (Google's calendarList.list takes only a minimum
      // access role, and synced is this store's own), and every calendar it answers is saved, so they narrow here.
      const found = [...(await run.source().calendars()), ...((await run.feeds?.().source.calendars()) ?? [])]
      const listed = await run.store.saveCalendars(run.accountId, found, now())
      const items = listed
        .map(calendarItem)
        .filter((item) => terms.every(([field, value]) => String(item[field as keyof typeof item]) === value))
      return listBody(command, { items, page: 1 })
    })
  })
  for (const [name, synced] of [
    ["sync", true],
    ["unsync", false],
  ] as const)
    example(
      annotate(calendars.command(name), { effects: LOCAL_WRITE })
        .description(synced ? "sync this calendar from now on" : "stop syncing this calendar; what is stored stays")
        .argument("<calendar>", "the calendar's id, the provider's id, or its title"),
      `calendars ${name} 3`,
    ).action(async (reference: string, _opts: unknown, command: Command) => {
      await within(command, async (run) => {
        const calendar = await calendarIn(run.store, run.accountId, reference)
        await run.store.setCalendarSynced(calendar.id, synced, now())
        return itemBody(calendarItem({ ...calendar, synced }))
      })
    })

  if (options.feeds) {
    const feedsOf = (run: CalendarRun) => {
      if (!run.feeds) throw new CliError("configuration_error", "this profile follows no feeds")
      return run.feeds()
    }
    example(
      // A fetch, but also a new secret and a new address every later sync reads: the read-only lock refuses it.
      changesStore(annotate(calendars.command("add"), { effects: FETCH, offline: false, mcp: false }))
        .description(
          "follow an iCalendar feed, such as a holiday calendar or a published .ics address, as a read-only calendar " +
            "of this profile that sync reads again each time; the address is kept as a secret and never printed",
        )
        .summary("follow an iCalendar feed as a read-only calendar")
        .addArgument(secretInput(new Argument("<url>", "the feed's https://, http:// or webcal:// address")))
        .option("--title <title>", "the calendar's title; the feed's own name if not given"),
      "calendars add webcal://example.com/holidays.ics --title Holidays",
    ).action(async (url: string, opts: { title?: string }, command: Command) => {
      if (command.optsWithGlobals<{ offline?: boolean }>().offline)
        throw new CliError("permission_error", "calendars add reads the feed; leave out --offline")
      await within(command, async (run) => {
        const { calendar, events } = await feedsOf(run).add(url, opts.title === undefined ? {} : { title: opts.title })
        if (isPlainHttp(url))
          outputFor(command).renderer.warn(
            "this feed's address starts with http://, so the feed and any token in its address travel unencrypted; " +
              "use https:// if the server offers it",
          )
        const [saved] = await run.store.saveCalendars(run.accountId, [calendar], now())
        return itemBody({
          ...calendarItem(saved as NonNullable<typeof saved>),
          events,
          hint: `run ${lineOf(command, "sync")} to store its events`,
        })
      })
    })
    example(
      annotate(calendars.command("remove"), { effects: LOCAL_WRITE, mcp: false })
        .description(
          "stop following a feed calendars add added: its address is forgotten and its stored events are deleted, " +
            "not cancelled; only a feed, as calendars unsync stops a provider's calendar",
        )
        .argument("<calendar>", "the feed calendar's id, its ics: id, or its title"),
      "calendars remove 7",
    ).action(async (reference: string, _opts: unknown, command: Command) => {
      await within(command, async (run) => {
        const calendar = await calendarIn(run.store, run.accountId, reference)
        if (!isFeedCalendar(calendar))
          throw new CliError(
            "validation_error",
            `calendar ${calendar.id} is not a feed; calendars remove takes only feeds`,
            { reason: "feed.not-a-feed" },
          )
        await feedsOf(run).remove(calendar.externalId)
        const { entries, events } = await run.store.forgetCalendar(calendar.id, now())
        return itemBody({ ...calendarItem({ ...calendar, synced: false }), removed: entries, events })
      })
    })
  }

  if (options.freeBusy)
    example(
      withQuery(
        annotate(calendars.command("busy"), { effects: REMOTE_READ, offline: false, partial: true }).description(
          "when calendars and people are taken, asked of the provider and not stored; with --duration-minutes, " +
            "the free stretches they share",
        ),
        BUSY_QUERY,
      ).addHelpText("after", BUSY_QUERY_NOTE),
      "calendars busy person:ana@example.com --json",
      "calendars busy starts_at>=2026-11-02 ends_at<=2026-11-06 person:ana@example.com --duration-minutes 30 " +
        "--hours 10:00-16:00",
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
        await within(command, async (run) => {
          const query = await busyQuery(words, { store: run.store, accountId: run.accountId, zone: zone(), now: now() })
          const { meta, ...busy } = await busyAnswer(run.source(), query, {
            zone: zone(),
            now: now(),
            ...(opts.durationMinutes === undefined ? {} : { slot: { minutes: opts.durationMinutes, hours } }),
          })
          return itemBody(busy, { meta })
        })
      })

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
      await within(command, async (run) => {
        if (opts.embed && !run.messages) throw new CliError("configuration_error", "this tool cannot embed events")
        const report = await syncWithFeeds(run.source(), run.feeds?.(), run.store, {
          accountId: run.accountId,
          now: now(),
          budget: runBudgetOf(command, opts.maxPages),
          ...(signal ? { signal } : {}),
          ...(opts.rescan ? { full: true } : {}),
          ...(run.expand ? { expand: run.expand } : {}),
        })
        // A run its budget stopped has no time left for the model; the run that finishes the round embeds.
        const embeddings =
          opts.embed && !report.stopped && run.messages
            ? await embedEvents(run.messages, {
                maxChunks: EMBED_MAX,
                ...(run.env ? { env: run.env } : {}),
                command: options.app.command,
              })
            : undefined
        const failed = report.synced.filter((one) => one.error !== undefined)
        const timeout = command.optsWithGlobals<{ timeout?: string }>().timeout
        // The same command again, never --rescan: that would drop the round this run leaves in progress. A run that
        // moved nothing on would only repeat itself, so it gets no step; a sync sends the provider no write, so
        // running it again is safe.
        const stuck = report.state === "partial" && report.progress.steps === 0 && failed.length === 0
        const why = failed.length
          ? "a calendar failed to sync; running sync again retries it"
          : "the sync stopped before its end to answer in time; running it again goes on from there"
        const next: NextStep[] | undefined =
          failed.length || (report.state === "partial" && !stuck)
            ? [
                {
                  kind: "command",
                  step: "calendar.sync",
                  command: "sync",
                  args: Object.fromEntries(
                    Object.entries({ max_pages: opts.maxPages, timeout, embed: opts.embed }).filter(
                      ([, value]) => value !== undefined,
                    ),
                  ),
                  why,
                  safe_to_auto_execute: true,
                },
              ]
            : undefined
        const progressAt = lineOf(command, "store status")
        report.hint = failed.length
          ? `${failed.map((one) => `calendar ${one.calendarId} (${one.title ?? one.externalId}): ${one.error}`).join("; ")}` +
            " — run sync again to retry"
          : stuck
            ? `this run moved nothing on: raise --timeout or --max-pages, then run sync again; see progress: ${progressAt}`
            : report.state === "partial"
              ? `run sync again to continue; see progress: ${progressAt}`
              : report.hint
        if (report.hint === undefined) delete report.hint
        // What the healthy calendars brought is saved and answered; each failed one is an issue (WC-OUT-7, WC-OUT-8).
        const issues = failed.map((one) => ({
          code: "provider_error" as const,
          reason: "sync.partial",
          source: `calendar:${one.calendarId}`,
        }))
        const partial = report.state === "partial" || issues.length > 0
        return itemBody(
          { ...report, ...(embeddings === undefined ? {} : { embeddings }) },
          {
            ...(partial ? { meta: { complete: false, ...(issues.length ? { issues } : {}) } } : {}),
            ...(next ? { next } : {}),
          },
        )
      })
    })

  const store = annotate(program.command("store").description("the local store of calendar events"), {
    effects: GROUP,
  })
  example(
    annotate(store.command("status"), { effects: LOCAL_READ }).description(
      "how far each synced calendar's sync is: entries done, partial or complete, and when it last moved",
    ),
    "store status --json",
  ).action(async (_opts: unknown, command: Command) => {
    await within(command, async (run) =>
      listBody(command, await calendarStatus(run.store, run.accountId, { profile: run.profile, now: now() })),
    )
  })

  const personOfEmail = (run: CalendarRun): PersonOfEmail | undefined => {
    const shared = run.messages
    return shared
      ? async (email) => {
          const person = await shared.people.personOf({ provider: "email", id: email })
          return person ? `person:${person.uid}` : null
        }
      : undefined
  }
  const personId =
    (run: CalendarRun) =>
    async (reference: string): Promise<number | null> => {
      const text = reference.replace(/^person:/u, "")
      if (/^[1-9]\d*$/u.test(text)) return Number(text)
      const person = await messagesOf(run, "person:").people.personOf({
        provider: "email",
        id: text.trim().toLowerCase(),
      })
      return person ? Number(person.uid) : null
    }

  const events = annotate(program.command("events").description("the account's stored events"), { effects: GROUP })
  example(
    withQuery(
      annotate(events.command("list"), { effects: LOCAL_READ, partial: true }).description(
        "list stored events, earliest first; --source reads several accounts as one list",
      ),
      EVENTS_QUERY,
    ).addHelpText("after", EVENTS_QUERY_NOTE),
    "events list 'starts_at:[2026-11-02 TO 2026-11-07}' --json",
    "events list ends_at>=today person:ana@example.com",
    "events list overlapping:true --source all",
  )
    .option("--limit <n>", "events per page, 1–1000", integer, 100)
    .option("--page <n>", "which page, starting at 1", integer, 1)
    .option(
      "--source <accounts>",
      "calendar accounts held in the store to read as one list: all, a provider, or a list such as " +
        `${options.app.command}:work,${options.app.command}:personal or group:<name>; the profile's account when absent`,
    )
    .action(async (words: string[], opts: { limit: number; page: number; source?: string }, command: Command) => {
      await within(command, async (run) => {
        const own: ReadAccount = { id: run.accountId, key: run.account }
        const { accounts, skipped } =
          opts.source === undefined
            ? { accounts: [own], skipped: [] }
            : await sourceAccounts(messagesOf(run, "--source"), run.account, opts.source, options.app.command)
        if (run.locked && accounts.some(({ id }) => id !== own.id))
          throw new CliError(
            "permission_error",
            "this process is locked to one profile; --source may name only its own account",
            { reason: "profile.locked" },
          )
        const filter = await eventsFilter(words, {
          store: run.store,
          accountId: run.accountId,
          accountIds: accounts.map(({ id }) => id),
          zone: zone(),
          now: now(),
          personOf: personId(run),
        })
        return listBody(
          command,
          eachMarked(
            await eventsAnswer(run.store, filter && { ...filter, limit: opts.limit }, opts.page),
            EVENT_ITEM_UNTRUSTED,
          ),
          { ...(await accountsMeta(run.store, accounts, skipped, now())), ...clockMeta(now(), zone()) },
        )
      })
    })
  const exporter = example(
    withQuery(
      annotate(events.command("export"), { effects: LOCAL_WRITE }).description(
        `write stored events as iCalendar (.ics), at most ${EXPORT_MAX}: one with id:<id>, or those the query ` +
          "finds; each occurrence of a repeating event as an event of its own",
      ),
      EVENTS_QUERY,
    ).addHelpText("after", EVENTS_QUERY_NOTE),
    "events export id:42 --output planning.ics",
    "events export 'starts_at:[2026-11-02 TO 2026-11-09}' NOT event_type:birthday --output week.ics",
  )
  // Not over MCP: an agent would choose where on the owner's disk to write. It gets the text in the answer.
  writesFileOnlyWith(
    exporter.addOption(ownerOnlyOption("--output <file>", "the file to write; printed in the answer when absent")),
    "output",
  )
  exporter.action(async (words: string[], opts: { output?: string }, command: Command) => {
    if (opts.output !== undefined && !opts.output.trim())
      throw new CliError("validation_error", "--output names no file")
    await within(command, async (run) => {
      const filter = await eventsFilter(words, {
        store: run.store,
        accountId: run.accountId,
        zone: zone(),
        now: now(),
        personOf: personId(run),
      })
      const exported = await eventsIcs(run.store, run.accountId, filter, { now: now(), product: options.app.command })
      if (opts.output === undefined) return itemBody({ ...exported, untrusted: ["content"] })
      await (options.writeFile ?? writeIcsFile)(opts.output, exported.content)
      return itemBody({ format: exported.format, events: exported.events, output: opts.output })
    })
  })
  example(
    annotate(events.command("show"), { effects: LOCAL_READ })
      .description("one event: its calendar copies, attendees with their person, Drive files and history")
      .argument("<event>", "the event's id, or event:<id>"),
    "events show event:42 --json",
  ).action(async (reference: string, _opts: unknown, command: Command) => {
    await within(command, async (run) => {
      const shown = await eventAnswer(await eventOf(run.store, run.accountId, eventIdOf(reference)), personOfEmail(run))
      return itemBody({ ...shown, untrusted: CALENDAR_UNTRUSTED_FIELDS })
    })
  })

  example(
    annotate(events.command("prepare"), { effects: LOCAL_READ, partial: true })
      .description(
        "before a meeting: the event, its attendees with their answer, and each one's latest messages, mail and " +
          "meetings the store holds; the next meeting when no event is named",
      )
      .summary("what the store holds for one meeting and the people in it")
      .argument("[event]", "the event's id, or event:<id>; the next meeting with other attendees when absent"),
    "events prepare --json",
    "events prepare event:42 --limit 3",
    "events prepare event:42 --since-time 2026-10-01",
  )
    .option("--limit <n>", `messages per person in each list, 1–50; ${PREPARE_MESSAGES} if not given`, upTo(50))
    .option("--since-time <time>", "no message or meeting older than this ISO 8601 time, or 30d ago")
    .action(async (reference: string | undefined, opts: { limit?: number; sinceTime?: string }, command: Command) => {
      const window = dateWindow({
        ...(opts.sinceTime === undefined ? {} : { sinceTime: opts.sinceTime }),
        zone: zone(),
        now: now(),
      })
      await within(command, async (run) => {
        const details =
          reference === undefined
            ? await nextMeeting(run.store, run.accountId, now())
            : await eventOf(run.store, run.accountId, eventIdOf(reference))
        const { meta, ...prepared } = await eventPreparation(details, {
          store: run.store,
          messages: messagesOf(run, "events prepare"),
          account: { id: run.accountId, key: run.account },
          personOf: personOfEmail(run) ?? (async () => null),
          now: now(),
          ...(opts.limit === undefined ? {} : { limit: opts.limit }),
          ...(window.since === undefined ? {} : { since: window.since }),
        })
        return itemBody(prepared, { meta: { ...meta, ...window.meta, ...clockMeta(now(), zone()) } })
      })
    })

  if (options.writes) addRemind(events, { within, now, zone, example })

  const searches = annotate(
    program.command("search").description("find stored things by text: events, or all of messages, notes and events"),
    { effects: GROUP },
  )
  addSearchAll(searches, { within, app: options.app, zone, example })
  const search = example(
    annotate(searches.command("events"), { effects: options.serverSearch ? LOCAL_OR_REMOTE_READ : LOCAL_READ })
      .description(
        options.serverSearch
          ? "find stored events by words, and by meaning when its model is downloaded; with --backend server, ask " +
              "the provider instead, or with --backend both, ask both"
          : "find stored events by words, and by meaning when its model is downloaded",
      )
      .argument("<query...>", "what to find in titles, descriptions, places and attendees"),
    "search events roadmap planning --json",
    ...(options.serverSearch
      ? ["search events --backend server quarterly review", "search events --backend both quarterly review"]
      : []),
  )
    .option("--limit <n>", "events per page", integer, 20)
    .option(
      "--cursor <cursor>",
      "go on from where the last page stopped; page.next gives it",
      (text) => (text === "0" ? 0 : integer(text)),
      0,
    )
    .option("--exact", "every word as written, no word stems")
    .option("--newest", "latest start first instead of best first")
  if (options.serverSearch)
    search.addOption(
      new Option(
        "--backend <archive|server|both>",
        "where to search: archive, the local store, or server, the provider's own search over the synced calendars, " +
          "earliest first; both gives the store's hits, each the provider also found marked server, then the " +
          "provider's other hits, one page with no cursor",
      )
        .choices(["archive", "server", "both"])
        .default("archive"),
    )
  search.action(
    async (
      words: string[],
      opts: { limit: number; cursor: number; exact?: boolean; newest?: boolean; backend?: string },
      command: Command,
    ) => {
      const flag = `search events --backend ${opts.backend}`
      const server = opts.backend === "server" || opts.backend === "both"
      if (server) {
        if (command.optsWithGlobals<{ offline?: boolean }>().offline)
          throw new CliError("permission_error", `${flag} asks the provider; leave out --offline`, {
            reason: "search.offline",
          })
        if (opts.backend === "server" && opts.exact)
          throw new CliError("validation_error", `${flag} takes no --exact: the provider matches words its own way`, {
            reason: "search.server-options",
          })
        if (opts.cursor || opts.newest)
          throw new CliError(
            "validation_error",
            `${flag} takes neither --cursor nor --newest: the provider ranks and pages its own hits`,
            { reason: "search.server-options" },
          )
      }
      await within(command, async (run) => {
        const archived = () =>
          searchEvents(messagesOf(run, "search"), words.join(" "), {
            accounts: [run.account],
            limit: opts.limit,
            offset: opts.cursor,
            timezone: zone(),
            command: options.app.command,
            ...(opts.exact ? { exact: true } : {}),
            ...(opts.newest ? { newest: true } : {}),
          })
        if (!server) return hitsBody(command, { ...(await archived()), untrusted: SEARCH_UNTRUSTED })
        const served = await serverSearchAnswer(run.source(), run.store, {
          accountId: run.accountId,
          account: run.account,
          query: words.join(" "),
          limit: opts.limit,
        })
        if (opts.backend === "server") return hitsBody(command, { ...served, untrusted: SERVER_SEARCH_UNTRUSTED })
        return hitsBody(command, {
          ...(await bothSearchAnswer(run.store, run.accountId, await archived(), served, opts.limit)),
          untrusted: SEARCH_UNTRUSTED,
        })
      })
    },
  )

  if (options.writes) addEventWrites(events, options.writes, { within, now, zone, example, readFile: options.readFile })

  const people = annotate(program.command("people").description("the people in the account's events"), {
    effects: GROUP,
  })
  withQuery(
    example(
      annotate(people.command("list"), { effects: LOCAL_READ }).description(
        "one event's attendees, or everyone attending this week's events",
      ),
      "people list --json",
      "people list event:42",
    ),
    PEOPLE_QUERY,
  ).action(async (words: string[], _opts: unknown, command: Command) => {
    const reference = queryTerms(words, PEOPLE_QUERY, "people list").get("event")
    const event = reference === undefined ? undefined : eventIdOf(reference)
    await within(command, async (run) => {
      const filter = event === undefined ? weekFilter(run.accountId, zone(), now()) : undefined
      const personOf = personOfEmail(run)
      const found = await peopleAnswer(run.store, run.accountId, {
        ...(event === undefined ? {} : { event }),
        ...(filter ? { filter } : {}),
        ...(personOf ? { personOf } : {}),
      })
      return listBody(command, eachMarked(found, ATTENDEE_UNTRUSTED))
    })
  })
  addPeopleLink(people, { within, example })

  const links = annotate(program.command("links").description("calendar copies the rules could not join alone"), {
    effects: GROUP,
  })
  example(
    annotate(links.command("review"), { effects: LOCAL_READ }).description(
      "copies that fit two or more events equally well, waiting for the owner's choice",
    ),
    "links review --json",
  ).action(async (_opts: unknown, command: Command) => {
    await within(command, async (run) => {
      // Locked to a profile (WC-ACCT-5), or with no shared store to name the others by, only the profile's own account.
      const own = run.locked || !run.messages
      const found = await reviewsAnswer(run.store, own ? [run.accountId] : undefined)
      const accounts = own
        ? [`${run.account.provider}:${run.account.account}`]
        : await calendarAccountNames(run.store, messagesOf(run, "links review"), run.account)
      return listBody(command, eachMarked(found, REVIEW_UNTRUSTED), { accounts, complete: true })
    })
  })
  example(
    annotate(links.command("resolve"), { effects: LOCAL_WRITE })
      .description("join a copy to the event you choose, or keep it apart")
      .argument("<review>", "the review's id from links review")
      .argument("<choice>", "one of its candidates, as event:<id>, or apart"),
    "links resolve 7 event:42",
  ).action(async (review: string, choice: string, _opts: unknown, command: Command) => {
    await within(command, async (run) => itemBody(await resolveAnswer(run.store, run.accountId, review, choice, now())))
  })

  const leaves = (command: Command): Command[] =>
    command.commands.length ? command.commands.flatMap(leaves) : [command]
  declareCalendarAnswers(program, program.commands.filter((one) => !mounted.has(one)).flatMap(leaves))
}

/** Opens the profile for one command, builds its answer and prints it once the profile is closed. */
export type Within = (
  command: Command,
  work: (run: CalendarRun) => Promise<Body>,
  view?: (body: Body) => string,
) => Promise<void>

export interface CommandHelpers {
  within: Within
  now: () => number
  zone: () => string
  example: (command: Command, ...lines: string[]) => Command
}

const collect = (value: string, previous: string[] = []) => [...previous, value]

interface WriteHelpers extends CommandHelpers {
  readFile?: (path: string) => Promise<string>
}

const addEventWrites = (
  events: Command,
  traits: NonNullable<CalendarCommandOptions["writes"]>,
  { within, now, zone, example, readFile }: WriteHelpers,
) => {
  const contextOf = (run: CalendarRun, command: Command): WriteContext => {
    if (!run.writes) throw new CliError("configuration_error", "this profile cannot write to its calendars")
    return {
      store: run.store,
      accountId: run.accountId,
      writes: run.writes(),
      ask: terminalAsker(command),
      now: now(),
      zone: zone(),
      names: {
        notify: "--notify or --no-notify",
        id: "--operation-id",
        calendar: "--calendar",
        series: "--series",
        following: "--following",
        repeat: "--repeat",
      },
    }
  }
  const written = (command: Command, write: (context: WriteContext) => Promise<object>) =>
    within(command, async (run) =>
      itemBody({ ...(await write(contextOf(run, command))), untrusted: CALENDAR_UNTRUSTED_FIELDS }),
    )
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
  const flagOf = (field: string) =>
    field === "attendees" ? "--attendee" : `--${field.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`
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
      .option("--calendar <id>", "the calendar, by id or title, when the event is on more than one of the account's")

  const quick = traits.quickAdd === true
  const create = example(
    notify(
      fields(write("create"), false)
        .description(
          quick
            ? "add an event to a calendar; with --repeat, one that repeats; with --text, one the provider reads " +
                "from a line such as 'Lunch with Ana tomorrow 1pm'"
            : "add an event to a calendar; with --repeat, one that repeats",
        )
        .argument("<calendar>", "the calendar's id, the provider's id, or its title"),
    ).option(
      "--operation-id <id>",
      "the operation_id a create that ended in outcome_unknown named: a retry finds that event",
    ),
    quick
      ? "events create Work --text 'Example lunch with Ana tomorrow 1pm at Example Cafe'"
      : "events create 3 --title 'Example planning' --start-time 2026-11-02T10:00 --end-time 2026-11-02T11:00",
    "events create 3 --title 'Example review' --start-date 2026-11-03 --end-date 2026-11-03 " +
      "--attendee ana@example.com --no-notify",
    "events create 3 --title 'Example standup' --start-time 2026-11-02T09:30 --end-time 2026-11-02T09:45 " +
      "--repeat 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=12'",
  )
  if (quick)
    create.option(
      "--text <text>",
      "one line the provider reads the title, date, time and place from, in place of the other fields; nobody is " +
        "mailed without --notify",
    )
  create.action(
    async (
      calendar: string,
      opts: FieldOptions & Choices & { operationId?: string; text?: string },
      command: Command,
    ) => {
      const { notify: choice, operationId: id, text, ...rest } = opts
      const options = { ...(choice === undefined ? {} : { notify: choice }), ...(id === undefined ? {} : { id }) }
      if (text !== undefined) {
        const given = Object.keys(fieldsOf(rest))
        if (given.length)
          throw new CliError(
            "validation_error",
            `--text takes the whole event from its line; leave out ${given.map(flagOf).join(", ")}`,
            { reason: "event.text-with-fields", param: "--text" },
          )
        await written(command, (context) => createEventFromText(context, calendar, text, options))
        return
      }
      await written(command, (context) => createEvent(context, calendar, fieldsOf(rest), options))
    },
  )
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
        .option(
          "--operation-id <id>",
          "with --following, the operation_id an outcome_unknown named: a retry finds that new series",
        ),
    ),
    "events update event:42 --start-time 2026-11-02T14:00 --end-time 2026-11-02T15:00 --notify",
    "events update event:42 --series --repeat 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231T230000Z' --no-notify",
    "events update event:42 --following --start-time 2026-11-09T10:00 --end-time 2026-11-09T10:30 --no-notify",
  ).action(async (reference: string, opts: FieldOptions & Choices & { operationId?: string }, command: Command) => {
    const {
      calendar: _calendar,
      series: _series,
      following: _following,
      notify: _notify,
      operationId: id,
      ...rest
    } = opts
    await written(command, (context) =>
      updateEvent(context, reference, fieldsOf(rest), { ...choicesOf(opts), ...(id === undefined ? {} : { id }) }),
    )
  })
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
  ).action(async (reference: string, opts: Choices, command: Command) => {
    await written(command, (context) => deleteEvent(context, reference, choicesOf(opts)))
  })
  if (traits.importEvent)
    example(
      write("import")
        .description(
          `add the events of an iCalendar (.ics) file to a calendar, at most ${IMPORT_MAX}, each under its own UID; ` +
            "nobody is mailed; a changed occurrence of a repeating event (RECURRENCE-ID) is skipped",
        )
        .argument("<calendar>", "the calendar's id, the provider's id, or its title")
        .argument("<file>", "the .ics file to read"),
      "events import Work planning.ics",
    ).action(async (calendar: string, file: string, _opts: unknown, command: Command) => {
      const text = await (readFile ?? readIcsFile)(file)
      if (Buffer.byteLength(text, "utf8") > ICS_MAX_BYTES)
        throw new CliError("validation_error", `${file} is larger than ${ICS_MAX_BYTES / 1024 / 1024} MB`, {
          reason: "ics.too-large",
        })
      await within(command, async (run) =>
        itemBody({ ...(await importEvents(contextOf(run, command), calendar, text)), untrusted: IMPORT_UNTRUSTED }),
      )
    })
  if (traits.move)
    example(
      notify(
        target(write("move"))
          .description("move an event, with its id, to another calendar of the account; a repeating one moves whole")
          .requiredOption("--to-calendar <id>", "the calendar to move it to: its id, the provider's id, or its title")
          .option("--series", "move the whole repeating event an occurrence belongs to"),
      ),
      "events move event:42 --to-calendar 4 --no-notify",
    ).action(async (reference: string, opts: Choices & { toCalendar: string }, command: Command) => {
      const { series, calendar, notify } = opts
      await written(command, (context) =>
        moveEvent(context, reference, opts.toCalendar, choicesOf({ series, calendar, notify })),
      )
    })
  example(
    notify(
      target(write("respond"))
        .description("answer an invitation; the organiser is told only with --notify")
        .addArgument(new Argument("<response>", "the answer").choices(EVENT_RESPONSES)),
    ),
    "events respond event:42 accepted --notify",
  ).action(async (reference: string, response: EventResponse, opts: Choices, command: Command) => {
    await written(command, (context) => respondToEvent(context, reference, response, choicesOf(opts)))
  })
}

// honoursDryRun: a host program other than `run` would otherwise let a write through under --dry-run.
export const addCalendarCommands = honoursDryRun(sharedCommand(addCalendarCommandsDefinition))
