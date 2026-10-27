import { CliError } from "@wirecat/cli-base"
import { annotate, sharedCommand } from "@wirecat/cli-base/commands"
import { timezoneOf } from "@wirecat/cli-base/query"
import type { Effects } from "@wirecat/cli-base/standards"
import { type Command, InvalidArgumentError } from "commander"
import type { EventStore } from "../../meetings/index.js"
import { searchEvents } from "../../services/events-search.js"
import { linkPeople } from "../../services/people.js"
import type { AccountKey, MessageStore } from "../../store/store.js"
import {
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
import type { CalendarExpander, CalendarSource } from "../source.js"
import { syncCalendars } from "../sync.js"

export interface CalendarCommandDeps {
  store: EventStore
  /** The selected profile's calendar account: every command reads and syncs only it. */
  accountId: number
  /** The same account as the shared store names it, for search and people. */
  account: AccountKey
  /** The shared store: `search`, `people link` and the person of an attendee read it. */
  messages?: MessageStore
  /** The provider; `sync` and `calendars list` read it. */
  source?: CalendarSource
  /** For a source with `expands: "local"`. */
  expand?: CalendarExpander
  /** After `sync --embed`: embeds new events for search by meaning (`embedEvents`), as drive's `sync --embed`. */
  embed?: (max: number) => Promise<unknown>
  write: (value: unknown, format: "json" | "jsonl" | "text") => void
  now?: () => number
  /** The zone `today`, `week` and a bare date are read in; the computer's when absent. */
  timezone?: string
}

const LOCAL_READ: Effects = { remote: "none", local: "read" }
const LOCAL_WRITE: Effects = { remote: "none", local: "write" }
const FETCH: Effects = { remote: "read", local: "write" }
const GROUP: Effects = { remote: "none", local: "none" }
/** How many pieces one `sync --embed` embeds, as drive's. */
const EMBED_MAX = 600

const integer = (text: string) => {
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text)))
    throw new InvalidArgumentError("expected a positive integer")
  return Number(text)
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

  output(
    example(
      annotate(program.command("sync"), { effects: FETCH, offline: false }).description(
        "bring the synced calendars up to date: what changed since the last sync, or everything with --full",
      ),
      "sync",
      "sync --full --embed",
    ),
  )
    .option("--full", "list every synced calendar's window again instead of reading changes")
    .option("--embed", "also index new events for meaning search, with a model already downloaded")
    .action(async (opts: { full?: boolean; embed?: boolean }, command: Command) => {
      const report = await syncCalendars(source(), deps.store, {
        accountId: deps.accountId,
        now: now(),
        ...(opts.full ? { full: true } : {}),
        ...(deps.expand ? { expand: deps.expand } : {}),
      })
      if (opts.embed && !deps.embed) throw new CliError("configuration_error", "this tool cannot embed events")
      const embeddings = opts.embed ? await deps.embed?.(EMBED_MAX) : undefined
      print(embeddings === undefined ? report : { ...report, embeddings }, command)
      if (!report.complete)
        throw new CliError("provider_error", "some calendars did not sync; run sync again to retry them", {
          reason: "sync.partial",
        })
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
      print(await eventsAnswer(deps.store, filter && { ...filter, limit: opts.limit }), command)
    })
  output(
    example(
      annotate(events.command("show"), { effects: LOCAL_READ })
        .description("one event: its calendar copies, attendees with their person, Drive files and history")
        .argument("<event>", "the event's id, or event:<id>"),
      "events show event:42 --json",
    ),
  ).action(async (reference: string, _opts: unknown, command: Command) => {
    print(await eventAnswer(await eventOf(deps.store, deps.accountId, eventIdOf(reference)), personOfEmail), command)
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
        print(
          await searchEvents(messages("search"), words.join(" "), {
            accounts: [deps.account],
            limit: opts.limit,
            offset: opts.cursor,
            timezone: zone(),
            command: program.name(),
            ...(opts.exact ? { exact: true } : {}),
            ...(opts.newest ? { newest: true } : {}),
          }),
          command,
        )
      },
    )

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
    print(
      await peopleAnswer(deps.store, deps.accountId, {
        ...(event === undefined ? {} : { event }),
        ...(filter ? { filter } : {}),
        ...(personOfEmail ? { personOf: personOfEmail } : {}),
      }),
      command,
    )
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
    print(await reviewsAnswer(deps.store), command)
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
    print(await resolveAnswer(deps.store, review, choice, now()), command)
  })
}

export const addCalendarCommands = sharedCommand(addCalendarCommandsDefinition)
