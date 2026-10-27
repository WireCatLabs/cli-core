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
| `freeBusy({ calendars, people, window })` | optional: each calendar's (by the provider's id) and each person's (by address) busy times inside the window, as `BusyTimes` (`{ id, busy, error? }`); a calendar the provider will not show has `error`, never an empty `busy` alone. Never stored |

Every value an adapter returns is already neutral: the words of the table in `src/meetings/event-store.ts`, IANA
zones, RFC 5545 recurrence lines, a join link without its query, no passcode or PIN. `removed` names only entries the
provider confirmed deleted, never one that only left the window.

## `syncCalendars(source, store, options)`

1. `source.calendars()` → `saveCalendars`; a new calendar syncs as `syncByDefault` says, a known one as the owner set.
2. For each synced calendar listed: the cursor (kept by `EventStore.setCursor`), and the window: a year back and three
   months ahead from the start of today in UTC. Calendars with a round in progress go first, then the one synced
   longest ago, so a rerun spends its budget where work was left.
3. A round in progress goes on, with its own window and token. Otherwise a full round (`cursor: null`) when asked
   (`full`, which also drops a round in progress), when the source is `fullListOnly`, when there is no cursor or it
   cannot be read, when the cursor holds a window that moved, or when the last full round is a day old. Otherwise
   only the changes.
4. Each page: `saveEntries`, then `removeEntries` for `removed`, then the cursor with the next page in it.
5. `{ reset: true }` for a page held since an earlier run means the page token expired: the round starts over, once.
   For the first page of a changes round it means the cursor is dead: the cursor is forgotten and one full round runs.
   A reset of a full list fails the calendar.
6. Occurrences: `expand` for `local` as each page comes, since it costs no request; for `on-request` the series ids
   are kept in the cursor and `occurrences()` asked for each after the listing, the cursor saved after each; nothing
   for `in-changes`.
7. After a full round, `markUnseen` marks what it has not seen since the round started (`startedAt`), so the pages
   an earlier run saved are not marked.
8. The cursor then holds the round's token and no round. A calendar that fails keeps its last saved page, and the
   others go on; the report says `complete: false` and repeats the error's text only when it is a `CliError` the
   adapter raised, since another error may carry a request URL with a token in it.

**The cursor** (`CalendarCursor`, version 2; a version 1 cursor reads as one with no round):

```json
{ "v": 2, "token": "…", "window": { "from": 0, "to": 0 }, "fullAt": 0, "updatedAt": 0, "done": 0,
  "round": { "full": true, "from": null, "window": { "from": 0, "to": 0 }, "startedAt": 0, "reset": false,
             "page": "…", "listed": false, "next": null, "series": ["…"] } }
```

`done` counts the entries the current or last round saved; `updatedAt` is when the cursor last moved.

**The budget** (`options.budget`, a `RunBudget` from `@wirecat/cli-core/background`). The engine asks `take()` before
every request: the calendar list, each page, each series' `occurrences()`. When it says no, the run stops where it
is, every finished page already saved, and the report says `state: "partial"`, `stopped` (`requests`, `deadline` or
`cancelled`), `requests` and `hint: "run sync again to continue"`. Each calendar has its own `state`. Without a budget
the run goes until every calendar is done. `options.signal` is checked before each save: a cancelled run keeps what
it saved and stops.

`runBudget({ requests?, deadline?, signal?, now? })` says no when `requests` are spent; when the deadline is closer
than the larger of 5 s and 15% of it, plus the slowest gap between two requests so far (one `occurrences()` may
page inside the adapter); or when the signal is aborted. Without `requests` it allows one per 2 s of the deadline
(15 in the default 30 s), and no limit when there is no deadline. `runBudgetOf(command, maxPages?)` from
`@wirecat/cli-core/cli` builds one from the deadline `run()` started (`environment.deadline()`) and the run's signal.
`--timeout` still sets the hard limit; the budget only makes the run stop before it.

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
| `sync [--full] [--max-pages <n>] [--embed]` | provider read, local write | `syncCalendars` with `runBudgetOf(command, --max-pages)`; `cooperative` and `partial`: a run the budget stops answers `state: "partial"` and exits 0, a calendar that failed exits with `provider_error` (`sync.partial`). `--embed` then calls `deps.embed(600)`, which a CLI binds to `embedEvents`, as drive's `sync --embed` does with `embedNotes`, unless the run stopped early |
| `calendars status` | local read | each synced calendar's sync in the WC-LIFE-14 shape (`progressOf`): `done`, `total: null`, `remaining: null`, `state`, `updated_at`, `cursor_age_ms`, plus `round` in progress and `line` (`progressLine`); `profile` is `deps.profile` |
| `events list [today\|week\|from:… to:…] [person:…] [calendar:…]` | local read | stored events, earliest first; without a time word from the start of today |
| `events show <event>` | local read | its calendar copies, attendees with their `person:`, Drive files, history |
| `search <words…>` | local read | `searchEvents` from `./services` over this account, never a copy of it |
| `people list [<event>]` | local read | one event's attendees, or everyone in this week's events with how many they attend |
| `people link <person> <other>` | local write | `linkPeople` from `./services`, the people service's own link (`email:ana@x.com telegram:12`) |
| `links review` / `links resolve <review> <choice>` | local read / write | copies that fit two events equally well, and the owner's choice (`event:<id>` or `apart`); the choices are kept per store, so every account's are listed |
| `calendars busy [today\|week\|from:… to:…] [calendar:…] [person:<email>…] [--duration-minutes <n>] [--hours 09:00-17:00]` | provider read | only when `deps.freeBusy` is set: `source.freeBusy` for the synced calendars (or those named) and each person named, this week by default; with `--duration-minutes`, the free stretches every one of them shares inside working hours, Monday to Friday, in the owner's zone (`slots`), and in `unknown` whoever the provider would not show. A person appears only by the address given; nothing is stored |

With a writer (`deps.writes`), `events create | update | delete | respond` exist too. `--repeat <rule>` on create
makes a repeating event: `repeatRule` checks an RFC 5545 subset (FREQ DAILY, WEEKLY or MONTHLY; INTERVAL; BYDAY,
with an ordinal only in MONTHLY; COUNT or UNTIL, UNTIL a date for an all-day event and a UTC time for a timed one)
and writes one `RRULE:` line in a fixed order into `EventDraft.recurrence`. On `update` the rule changes only with
`--series`; the series' EXDATE and RDATE lines are kept. New dates on a timed event, or times on an all-day one,
switch its kind: the patch carries the new kind only, and the adapter clears the other (Google: `events.update`
from the event as fetched, since `events.patch` cannot clear `dateTime` without a `null`). A series whose UNTIL,
EXDATE or RDATE holds the old kind is refused (`event.repeat-kind`), unless a new rule replaces an UNTIL. A write
that changes a rule saves only the series, and its answer says `hint: "sync to store its occurrences"`.

Each command's permission key is its path (`calendars.sync`, `people.link`), as `commandPermissions` reads it. The
command lint's vocabulary has no `calendars`, `people`, `unsync`, `review` or `resolve` yet, and `events list` takes
words rather than a field query, so a CLI baselines those rules until the vocabulary names them.

`calendarTools` and `callCalendarTool(store, name, input, { accountIds })` (`./calendar/mcp`) give the same reads as
MCP tools: `calendars_list`, `calendars_status` (its `profile` from the option `profileOf(accountId)`), `events_list`, `event_show`, `event_people`, `event_links_review`. Without `account_id`
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
that no meeting secret is in the output, a cancelled slot, a dead cursor, with `changed` a second round, and for a
source with `freeBusy` that each id is answered once inside the window and an unknown person is an error.
`calendarWriterContract` checks a stale etag, a retried create, notify, a repeat rule on create and on the series,
and a timed event switched to all-day and back.
`calendarSyncContract(make)` runs the engine over `fakeCalendarSource` for each of the twelve trait combinations, a
run the budget stops and the reruns that finish it with the store one whole run gives, a near deadline, and a page
token that expired between runs (`expirePages()`); cli-core
runs it over `memoryEventStore` and over the SQLite store.
