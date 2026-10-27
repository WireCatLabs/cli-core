# Calendars

`src/calendar/`, exported as `@wirecat/cli-core/calendar` and `/calendar/testing`. A calendar CLI (gcal, later an
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
   `complete: false` and names the error.

**What the engine does not do.** It writes no `syncs` row: no store method writes that table, so the run record of
the command that called it keeps the counts. A slot that stops being produced without a word (neither a cancelled
entry nor a removed id) is marked deleted by the next full round, not cancelled; Google sends a cancelled slot as a
cancelled exception, and a local expander returns an `EXDATE` slot as a cancelled occurrence, so the common cases
cancel. Embedding the events for search by meaning is the CLI's step after a sync (`embedEvents` in `./services`),
as drive calls `embedNotes`, because the engine knows only the `EventStore` port.

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
