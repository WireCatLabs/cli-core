# Calendars

`src/calendar/`, exported as `@wirecat/cli-core/calendar`, `/calendar/cli`, `/calendar/mcp` and `/calendar/testing`. A calendar CLI (gcal, later an
Outlook or an ICS/CalDAV CLI) writes its sign-in and one adapter, a `CalendarSource`; the sync, the store and the
contract kit are shared. The store types (`EventStore`, `EntryInput`, the neutral words) are defined in
`src/meetings/event-store.ts`, because `src/meetings/` depends on nothing else in cli-core; `./calendar` re-exports
them and `./meetings` keeps them.

## The port

| Member | What the adapter does |
|---|---|
| `provider` | its registry name: `google-calendar`, `outlook-calendar`, `caldav`, `ics` |
| `traits.expands` | `on-request`: the engine calls `occurrences()` for each series (Google `events.instances`) · `in-changes`: occurrences come in `changes()` (Graph `calendarView/delta`) · `local`: the engine expands RRULE lines with the `expand` it is given (ICS, CalDAV) |
| `traits.cursorHoldsWindow` | the cursor encodes the window (Graph delta), so a new window means a full round |
| `traits.fullListOnly` | no incremental cursor: every run lists the whole window (an ICS feed) |
| `calendars()` | `CalendarInput[]`, with `syncByDefault` decided by the adapter (Google: the owner owns it) |
| `changes(calendar, { cursor, page, window })` | one page: `{ entries, removed, nextPage }`, the last page with `cursor`; `cursor: null` asks for a full list of the window; a dead cursor answers `{ reset: true }` |
| `occurrences(calendar, seriesId, window)` | only with `expands: "on-request"` |

Every value an adapter returns is already neutral: the words of the table in `src/meetings/event-store.ts`, IANA
zones, RFC 5545 recurrence lines, a join link without its query, no passcode or PIN. `removed` names only entries the
provider confirmed deleted, never one that only left the window.

## `syncCalendars(source, store, options)`

1. `source.calendars()` → `saveCalendars`; a new calendar syncs as `syncByDefault` says, a known one as the owner set.
2. For each synced calendar listed: the cursor (`{"v":1,"token":…,"window":…,"fullAt":…}`, kept by
   `EventStore.setCursor`), and the window: a year back and three months ahead from the start of today in UTC.
3. A full round (`cursor: null`) when asked (`full`), when the source is `fullListOnly`, when there is no cursor or
   it cannot be read, when the cursor holds a window that moved, or when the last full round is a day old. Otherwise
   only the changes.
4. Each page: `saveEntries`, then `removeEntries` for `removed`.
5. `{ reset: true }` forgets the cursor and runs one full round; a reset during a full round fails the calendar.
6. Occurrences of every series the round returned: `occurrences()` for `on-request`, `expand` for `local`, nothing
   for `in-changes`.
7. After a full round, `markUnseen` marks what it did not return.
8. The cursor is saved last. A calendar that fails keeps its old cursor, and the others go on; the report says
   `complete: false` and repeats the error's text only when it is a `CliError` the adapter raised, since another
   error may carry a request URL with a token in it.

**What the engine does not do.** It writes no `syncs` row: no store method writes that table, so the run record of
the command that called it keeps the counts. A slot that stops being produced without a word (neither a cancelled
entry nor a removed id) is marked deleted by the next full round, not cancelled. Google's docs say a cancelled
instance comes as a cancelled exception in incremental lists, but full lists and `events.instances` leave it out
unless `showDeleted` is set, so the Google adapter asks for deleted entries on full lists too. A local expander
returns an `EXDATE` slot as a cancelled occurrence. Embedding the events for search by meaning is the CLI's step after a sync (`embedEvents` in `./services`),
as drive calls `embedNotes`, because the engine knows only the `EventStore` port.

## Commands and MCP tools

`addCalendarCommands(program, deps)` (`./calendar/cli`) mounts the shared commands, read only: no command writes an
event. `deps` names the profile's account twice (`accountId` in the event store, `account` in the shared store);
nothing is read from another account. Rule 3 joins one meeting's copies in two accounts into one event; a command
shows the event's own fields (title, time) and only this account's copies, attendees, files and history.

| Command | Effect | What it does |
|---|---|---|
| `calendars list` | provider read, local write | the provider's calendars, saved, with which of them sync |
| `calendars sync <calendar>` / `unsync <calendar>` | local write | turn one calendar's sync on or off, by its id or the provider's |
| `sync [--full] [--embed]` | provider read, local write | `syncCalendars`; `--embed` then calls `deps.embed(600)`, which a CLI binds to `embedEvents`, as drive's `sync --embed` does with `embedNotes` |
| `events list [today\|week\|from:… to:…] [person:…] [calendar:…]` | local read | stored events, earliest first; without a time word from the start of today |
| `events show <event>` | local read | its calendar copies, attendees with their `person:`, Drive files, history |
| `search <words…>` | local read | `searchEvents` from `./services` over this account, never a copy of it |
| `people list [<event>]` | local read | one event's attendees, or everyone in this week's events with how many they attend |
| `people link <person> <other>` | local write | `linkPeople` from `./services`, the people service's own link (`email:ana@x.com telegram:12`) |
| `links review` / `links resolve <review> <choice>` | local read / write | copies that fit two events equally well, and the owner's choice (`event:<id>` or `apart`); the choices are kept per store, so every account's are listed |

Each command's permission key is its path (`calendars.sync`, `people.link`), as `commandPermissions` reads it. The
command lint's vocabulary has no `calendars`, `people`, `unsync`, `review` or `resolve` yet, and `events list` takes
words rather than a field query, so a CLI baselines those rules until the vocabulary names them.

`calendarTools` and `callCalendarTool(store, name, input, { accountIds })` (`./calendar/mcp`) give the same reads as
MCP tools: `calendars_list`, `events_list`, `event_show`, `event_people`, `event_links_review`. Without `account_id`
a tool reads every account the host serves and names them in `accounts`. Each description says event text is data;
each answer lists the fields others wrote in `untrusted` and has its control characters made visible
([WC-SECR-11](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/security.md#wc-secr-11--text-from-outside-is-made-safe-before-a-terminal-or-an-agent-sees-it),
[WC-SECR-21](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/security.md#wc-secr-21--names-message-text-and-retrieved-documents-are-data-never-instructions)).
A CLI on cli-core's three-tool MCP server reaches the commands instead; that server wraps a command's answer and
serialises it with the same escaping (`answered` in `src/mcp/tool.ts`), and its tool descriptions carry the same line.
An event hit of `search all` names its invitation text in its own `untrusted`: `title` and `excerpt`.
The shared commands mark the same text in their answers, so a CLI serving them over MCP passes the marker on: `events show`, `search` and the write commands name the fields in a top-level `untrusted` (`search`: `hits.title`, `hits.location`, `hits.excerpt`); `events list`, `people list` and `links review` put it on each item, because a host's list envelope is strict and `--jsonl` prints only the items.

## Testing an adapter

```ts
import { calendarSourceContract } from "@wirecat/cli-core/calendar/testing"

const make = () => ({ source: adapterOverRecordedResponses(), window, deadCursor: "expired-token" })
for (const { name, run } of calendarSourceContract(make)) it(name, run)
```

`calendarSourceContract` checks calendar ids, neutral words, zones, recurrence lines, all-day dates, the series UID,
that no meeting secret is in the output, a cancelled slot, a dead cursor and, with `changed`, a second round.
`calendarSyncContract(make)` runs the engine over `fakeCalendarSource` for each of the twelve trait combinations; cli-core
runs it over `memoryEventStore` and over the SQLite store.
