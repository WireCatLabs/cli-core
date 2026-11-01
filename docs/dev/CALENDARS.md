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
| `search(calendar, { query, limit })` | optional: the provider's own text search over one calendar, at most `limit` entries, also outside the sync window, as `{ entries, more }`. Never stored |

Every value an adapter returns is already neutral: the words of the table in `src/meetings/event-store.ts`, IANA
zones, RFC 5545 recurrence lines, a join link without its query, no passcode or PIN. `removed` names only entries the
provider confirmed deleted, never one that only left the window.

## `syncCalendars(source, store, options)`

1. `source.calendars()` → `saveCalendars`; a new calendar syncs as `syncByDefault` says, a known one as the owner set.
2. For each synced calendar listed: the cursor (kept by `EventStore.setCursor`), and the window: a year back and three
   months ahead from the start of today in UTC. Calendars with a round in progress go first, then the one synced
   longest ago, so a rerun spends its budget where work was left.
3. A round in progress goes on, with its own window and token. Otherwise a full round (`cursor: null`) when asked
   (`full`, the CLI's `--rescan`, which also drops a round in progress, and is saved as each calendar's round before
   the first request, so a run its budget stops still lists the calendars it did not reach in full next time), when
   the source is `fullListOnly`, when there is no cursor or it
   cannot be read, when the cursor holds a window that moved, or when the last full round is a day old. Otherwise
   only the changes.
4. Each page: `saveEntries`, then `removeEntries` for `removed`, then the cursor with the next page in it.
5. `{ reset: true }` for a page held since an earlier run means the page token expired: the round starts over, once.
   For the first page of a changes round it means the cursor is dead: the cursor is forgotten and one full round runs.
   A reset of a full list fails the calendar.
6. Occurrences: `expand` for `local` as each page comes, since it costs no request; for `on-request` the series ids
   are kept in the cursor and `occurrences()` asked for each after the listing, the cursor saved after each; nothing
   for `in-changes`. A series' slots replace its stored ones in the window: a plain slot it no longer gives (the series
   moved, or dropped it) is cancelled, so an incremental round leaves no slot at the old time. `saveSlots` saves the
   slots of up to 50 series or 250 slots and the cursor in one transaction, so a sync commits a few times per calendar,
   not twice per series, and holds the write lock briefly. The daily full round asks only the series that changed
   (another etag than the stored one, or no stored slots in the window); the others keep their slots, counted as seen.
   Once the window's end has moved 7 days since every series was last asked (`slotsTo` in the cursor), or on
   `--rescan`, it asks every series, so a series that does not change lacks at most 7 days of slots at the window's far
   end.
7. After a full round, `markUnseen` marks what it has not seen since the round started (`startedAt`), so the pages
   an earlier run saved are not marked. It marks only what the list could return (`entryInWindow`): a single or a
   moved slot by its own time, a plain slot by its series' time, a series while it repeats into the window (by
   `recurrenceEndsAt`, else the rule's UNTIL; a COUNT series with no `recurrenceEndsAt` counts as repeating). Before
   its first round a calendar whose cursor lacks `restored` runs `restoreUnseen` once: builds up to 0.488.0 marked
   entries outside the window too, and no later list sees them again.
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
`cancelled`), `progress` (`calendars`, `calendarsDone`, `requests`, `saved`, `steps`) and `hint: "run sync again to
continue"`. Each calendar has its own `state`. Without a budget the run goes until every calendar is done.
`options.signal` is checked before each save: a cancelled run keeps what it saved and stops.

**The three limits.** Every one-shot command has a hard deadline (WC-LIFE-5); `--timeout` or `<PREFIX>_TIMEOUT`
sets it, higher or lower, and past it the command fails with `timeout`.

| Command | Default deadline | Why |
|---|---|---|
| one-shot | 30 s (`DEFAULT_COMMAND_MS`) | a command that hangs must fail |
| `cooperative`, at a terminal or in a script | 5 min (`DEFAULT_COOPERATIVE_MS`) | it stops on its own before the deadline and keeps its work |
| `cooperative` and `partial` (a resumable sync), at a terminal or in a script | 15 min (`DEFAULT_SYNC_MS`) | it spends a request budget, answers `partial` with `next` and loses nothing when it stops |
| `cooperative`, run for an MCP agent | 45 s (`DEFAULT_AGENT_COOPERATIVE_MS`) | MCP clients cut a tool call at about 60 s: the MCP TypeScript SDK's `DEFAULT_REQUEST_TIMEOUT_MSEC` is 60000 |

**The budget formula.** `requests = floor((deadline − margin) / requestMs)`, at least 1, where
`margin = max(5 s, 15% of the deadline)` and `requestMs` is how long one request to the provider usually takes: one
constant per CLI, `AppIdentity.requestMs` (2 s, `DEFAULT_REQUEST_MS`, when unset). So 12 requests in 30 s, 127 in
5 minutes and 19 in 45 s at 2 s each. A lower `--timeout` means fewer requests; `--max-pages` can lower the count
further, never raise it past what fits. The run stops at whichever comes first: the count spent, or the deadline
closer than the margin plus the slowest request so far (one `occurrences()` may page inside the adapter).
`runBudgetOf(command, maxPages?)` from `@wirecat/cli-core/cli` builds it from the deadline `run()` started
(`environment.deadline()`), the CLI's `requestMs` and the run's signal.

**How to go on.** A partial answer without a failed calendar carries `next`: one command step, `sync` with the same
`max_pages`, `timeout` and `embed` the run had and never `--rescan` (that would drop the round in progress), marked safe
to run unasked (it reads the provider and writes only the store). A host that renders it with `renderAnswer` prints
the whole line with the profile (`gcal personal sync`) as the last line in text, and an MCP agent gets the same
command and arguments to call again. A run that moved nothing on (no page read, no series expanded: `progress.steps` is 0, as with `--max-pages 1`) gets no step, only a hint to raise `--timeout` or `--max-pages`, so an agent never repeats it in a loop. The hint names `store status` (`gcal personal store status`), which shows the progress between runs.

**What the engine does not do.** It writes no `syncs` row: no store method writes that table, so the run record of
the command that called it keeps the counts. A slot that stops being produced without a word (neither a cancelled
entry nor a removed id) is marked deleted by the next full round, not cancelled. Google's docs say a cancelled
instance comes as a cancelled exception in incremental lists, but full lists and `events.instances` leave it out
unless `showDeleted` is set, so the Google adapter asks for deleted entries on full lists too. A local expander
returns an `EXDATE` slot as a cancelled occurrence. Embedding the events for search by meaning is the CLI's step after a sync (`embedEvents` in `./services`),
as drive calls `embedNotes`, because the engine knows only the `EventStore` port.

## Commands and MCP tools

`addCalendarCommands(program, deps)` (`./calendar/cli`) mounts the shared commands. Without `deps.writes` no
command writes an event. `deps` names the profile's account twice (`accountId` in the event store, `account` in the shared store);
nothing is read from another account, except by `events list --source`. Rule 3 joins one meeting's copies in two accounts into one event; a command
shows the event's own fields (title, time) and only this account's copies, attendees, files and history.

| Command | Effect | What it does |
|---|---|---|
| `calendars list [synced:… primary:… access_role:…]` | provider read, local write | the provider's calendars, saved, with which of them sync; the query narrows the whole list the provider answered (`CALENDARS_QUERY`) |
| `calendars sync <calendar>` / `unsync <calendar>` | local write | turn one calendar's sync on or off, by its id, the provider's or its title |
| `sync [--rescan] [--max-pages <n>] [--embed]` | provider read, local write | `syncCalendars` with `runBudgetOf(command, --max-pages)`; `cooperative` and `partial`: a run the budget stops answers `state: "partial"` with a `next` step and exits 0, a calendar that failed makes the run a failure: nothing on stdout (WC-OUT-14), and `provider_error` (`sync.partial`) whose message names each failed calendar and its error and whose `details.calendars` holds every synced calendar's result (`error` on the failed ones); it is safe to retry, as a sync sends the provider no write. `--embed` then calls `deps.embed(600)`, which a CLI binds to `embedEvents`, as drive's `sync --embed` does with `embedNotes`, unless the run stopped early |
| `store status` | local read | each synced calendar's sync in the WC-LIFE-14 shape (`progressOf`): `done`, `total: null`, `remaining: null`, `state`, `updated_at`, `cursor_age_ms`, plus `round` in progress and `line` (`progressLine`); `profile` is `deps.profile` |
| `events list [query…] [--source <accounts>] [--limit <n>] [--page <n>]` | local read, partial | stored events, earliest first, `--limit` per page (100) and `--page` from 1, so the host's `page.next` step can run, narrowed by the standard field query (`EVENTS_QUERY`): `starts_at` either way (`starts_at>=2026-11-02`, `starts_at<2026-11-07`, `starts_at:[2026-11-02 TO 2026-11-07}`, `starts_at:today`), `ends_at` from below only and strictly after its moment (`ends_at>=2026-11-02` leaves out an event that ends exactly then), `changed_at` from below only, `calendar:`, `person:`, `id:` (one event, whenever it is) and `event_type:` (`default`, `out-of-office`, `focus`, `working-location`, `birthday`, `from-mail`; a copy with no kind is `default`), which alone of the fields may also be excluded, `-event_type:birthday` or `NOT event_type:birthday`, as often as wanted (`nativeTermLists`' `negatable`). A kind counts only on the copies in the accounts read. Without `id`, `starts_at` or `ends_at`, events that end after the start of today. An all-day event is compared by its local dates (WC-TIME-5). `changed_at>=<date>` keeps the events `eventChange` finds new, moved or cancelled since then, each with `change`, `changed_at` and, when moved, `was`; it reads the copies' `created_at`, `deleted_at` and revisions, so it sees what the syncs saw. `overlapping:true` keeps the events whose time overlaps another's in the accounts read, each with `overlapping` and `overlaps` (the others, as `event:<id>`); `overlapping:false` keeps every other event. Only timed events that take the owner's time count: not cancelled or deleted, with a live copy in the accounts read that the owner did not decline, did not mark free (`transparent`) and that is not a working-location block. All-day events never overlap, and ends are exclusive, so back-to-back events do not. The store filters it with a self-join (`EventFilter.overlapping`). `--source` reads several calendar accounts as one list, resolved as `search messages --source` resolves it (`entriesOfList`, `fitting` to the `events` kind): `all`, a provider or its alias (`gcal`), `provider:account` by account or recorded profile, `group:<name>`. The store reads them in one query (`EventFilter.accountIds`), so a meeting two accounts hold is one item and paging stays exact. `calendar:` then names a calendar of any of them, and a provider id two of them hold is refused. Every answer has `meta.accounts`; `meta.complete` is false with an issue per account that has no synced calendar (`calendar.unsynced`) or a calendar whose sync never finished or is mid-round (`calendar.sync-incomplete`), and per `--source` entry that names no calendar account. With `deps.locked` (a profile lock), `--source` may name only the profile's own account (`profile.locked`) |
| `events export [query…] [--output <file>]` | local read; local write with `deps.writeFile` | the events `events list`'s query finds, at most 1000 (`export.too-many` beyond), as one iCalendar text (`eventsIcs`, `writeIcs` in `./calendar/ics`): UTC times, all-day dates with an exclusive `DTEND`, CRLF lines folded at 75 octets, no VTIMEZONE. Each event comes from its first live copy in the account; an occurrence is written as an event of its own, UID `<series UID>_<slot in UTC>`, so a file never holds two events with one UID, and the series' rule is not written. Google's API has no iCalendar export of one event, so cli-core writes it. The answer holds `content` (marked untrusted), or with `--output` the file's name |
| `events show <event>` | local read | its calendar copies, attendees with their `person:`, Drive files, history |
| `events prepare [event] [--limit <n>] [--since-time <time>]` | local read, partial | `eventPreparation` (`calendar/prepare.ts`): `events show`'s answer under `event`, and in `people` each attendee other than the owner and the rooms, the organiser first: their linked identities, `recent.direct` (one-to-one chats and mail) and `recent.groups` (`recordContext`, the body of `personContext`, read in every account that saw each identity), `past_events` with them, and their last two recorded meetings with five cues each (`personMeetingContext`). `--limit` messages per list (5). The first 10 attendees are read, within 128 KiB, the rest listed with `read: false` and `meta.truncated`. Without an event, the next meeting (`nextMeeting`): the earliest that starts after now, timed, not cancelled or declined, an ordinary event type, with someone other than the owner and the rooms invited; none is `not_found` (`calendar.no-upcoming`). `meta.accounts` names the calendar account and every account read; `meta.complete` is false with an issue per chat not held whole (`chat.not-read`, source `provider:account/chat`), for meetings not yet indexed by person (`meetings.index-pending`) and as `events list` for the calendar's own sync. `untrusted` names the event's and the people's third-party text. Nothing is summarised: an agent writes the brief |
| `search events <query…> [--backend archive\|server\|both]` | local read; provider read with `--backend server` or `both` | `searchEvents` from `./services` over this account, never a copy of it; `--cursor` takes the `next_offset` a page answers, which a host prints as `page.next_cursor`. Only when `deps.serverSearch` is set, `--backend server` asks `source.search` for each synced calendar instead (`serverSearchAnswer`): cancelled entries left out, earliest first, `found_by: ["server"]`, nothing stored; it refuses `--offline` (`search.offline`), `--exact`, `--cursor` and `--newest` (`search.server-options`). `--backend both` (`bothSearchAnswer`) runs both: the stored hits in the stored search's order, `server` added to `found_by` of each the provider also found (matched through its stored copy, a series and each of its occurrences to the stored hit of that series), then the provider's other hits; one page with no `next_offset`, `has_more` when either side has more; it refuses `--offline`, `--cursor` and `--newest` |
| `people list [event:<id>]` | local read | one event's attendees, or everyone in this week's events with how many they attend (`PEOPLE_QUERY`) |
| `people link <person> <other>` | local write | `linkPeople` from `./services`, the people service's own link (`email:ana@x.com telegram:12`) |
| `links review` / `links resolve <review> <choice>` | local read / write | copies that fit two events equally well, and the owner's choice (`event:<id>` or `apart`); the choices are kept per store, so every account's are listed, but only the profile's own account resolves one (`LinkReview.calendarId`) |
| `calendars busy [query…] [--duration-minutes <n>] [--hours 09:00-17:00]` | provider read | only when `deps.freeBusy` is set: `source.freeBusy` for the synced calendars (or those named) and each person named. The query (`BUSY_QUERY`) names the window by the answer's own `start` and `end` (`start>=2026-11-02 end<=2026-11-06`) and whom to ask, `calendar:<id>` and `person:<email>`, each repeatable; without `start` the window starts today, without `end` it lasts seven days; with `--duration-minutes`, the free stretches every one of them shares inside working hours, Monday to Friday, in the owner's zone (`slots`), and in `unknown` whoever the provider would not show. A person appears only by the address given; nothing is stored |

With a writer (`deps.writes`), `events create | update | delete | respond` exist too. `--repeat <rule>` on create
makes a repeating event: `repeatRule` checks an RFC 5545 subset (FREQ DAILY, WEEKLY or MONTHLY; INTERVAL; BYDAY,
with an ordinal only in MONTHLY; COUNT or UNTIL, UNTIL a date for an all-day event and a UTC time for a timed one)
and writes one `RRULE:` line in a fixed order into `EventDraft.recurrence`. On `update` the rule changes only with
`--series`; the series' EXDATE and RDATE lines are kept. New dates on a timed event, or times on an all-day one,
switch its kind: the patch carries the new kind only, and the adapter clears the other (Google: `events.update`
from the event as fetched, since `events.patch` cannot clear `dateTime` without a `null`). A series whose UNTIL,
EXDATE or RDATE holds the old kind is refused (`event.repeat-kind`), unless a new rule replaces an UNTIL. A write
that changes a rule saves only the series, and its answer says `hint: "sync to store its occurrences"`.

**A create from text.** With a writer that has the optional `quickAdd`, `events create <calendar> --text <line>`
hands the line to the provider, which reads the title, time and place its own way (Google's
[events.quickAdd](https://developers.google.com/workspace/calendar/api/v3/reference/events/quickAdd)); cli-core parses
no date. It is checked as `events.create`, plus `extraKeys("quick-add")`. The provider picks the id, so `--text`
refuses `--operation-id`, and a lost answer is `outcome_unknown` with `retryable: false`, saying to sync and look
before adding it again. Nobody is mailed without `--notify` (`events.notify`): the attendees are known only once the
provider has read the line. `--text` refuses the field options (`event.text-with-fields`).

**Importing a file.** With a writer that has the optional `importEvent` and `deps.readFile`, `events import <calendar>
<file>` reads the file's VEVENTs (`readIcs`: unfolding, quoted parameters, `TZID` kept as the zone's name, floating
times in the owner's zone, `DURATION`, RRULE, RDATE and EXDATE lines kept as written) and sends each to the provider
under its UID (Google's [events.import](https://developers.google.com/workspace/calendar/api/v3/reference/events/import),
which mails nobody). A changed occurrence (`RECURRENCE-ID`), an event with no UID, and a TZID that is no IANA zone
are `skipped`, each with its reason. At most 500 events and 10 MB a file. The key is `events.import`, `ask` by
default: one import writes a whole file, and may change events the calendar holds under the same UIDs; plus
`extraKeys("import")`. The whole import is one guarded write, one question and one journal line. A failure part way
names the UIDs imported before it (`imported`) and the one that failed.

**This and all following.** `events update <occurrence> --following` (MCP `following: true`) is built in cli-core
from the writer's `create` and `update`, so every adapter has it without code of its own. The occurrence's slot as
first scheduled (`originalStartsAt`) is the split. The new series is made first, with the change applied, under a
client-chosen id journaled before the call. It keeps the old series' rule, the attendees other than the owner, and
the EXDATE and RDATE dates from the split on. Then the old series is changed: its rule ends with UNTIL just before
the split (one second before for a timed event, the day before for an all-day one), COUNT gives way to that UNTIL,
and it keeps the dates before the split. Neither RFC 5545 nor Google's API has such a change; Google's
[recurring events guide](https://developers.google.com/workspace/calendar/api/guides/recurringevents) only warns against
changing the instances one by one for it. The order is chosen for retries:

- A conflict on the old series (its `etag` is old) comes after the new series exists. The error names the new
  series' id; after `sync`, the owner repeats with `--operation-id <id>`. The create finds that series and the old one ends.
- A lost answer on the old series (`outcome_unknown`) may mean it did end. The error says to sync first: if the
  series now ends before the occurrence, the split is done (and the occurrence is gone, so a retry would not find
  it); if not, repeat with `--operation-id <id>`.
- Over MCP, `event_create` and `event_update` take the same value as `operation_id`.
- Until then, later slots show twice, never not at all.
- A series already ending before the split is not split again: the command refuses, or with `--operation-id` only finds the
  new series.

The split refuses three things:

- a COUNT series without `--repeat`: only the provider knows how many slots are left (`event.repeat-count`);
- a switch between timed and all-day: use `--series`;
- an EXDATE or RDATE value it cannot read, such as a period (`event.repeat-split`).

On the series' first occurrence, `--following` is the same as `--series`. The new series carries what `EventDraft`
names; a Meet link, Drive files and reminders of the old series are not copied. `events delete <occurrence>
--following` is the old series' UNTIL change alone, checked against `events.delete`, which asks by default. `--following` and
`--series` do not go together. Both answers say `hint` to sync, which stores the occurrences of both series.

**Moving an event.** With a writer that has the optional `move`, `events move <event> --to-calendar <id>` (MCP
`event_move`, `to_calendar`) moves the event, keeping its id, to another calendar of the same account. It refuses:

- a calendar of another account: `calendarIn` reads only this one;
- the same calendar;
- a calendar the account only reads (`calendar.read-only`);
- an event type other than `default` (`event.unmovable`; Google's
  [events.move](https://developers.google.com/workspace/calendar/api/v3/reference/events/move) moves only those).

An occurrence moves only with its series (`--series`). The store cancels the old copy and saves the new one with the
same UID, so the event's rules join it to the same event. The key is `events.move`, plus `extraKeys("move")`.

Each command's permission key is its path (`calendars.sync`, `people.link`), as `commandPermissions` reads it. The
command lint's vocabulary has no `calendars`, `people`, `unsync`, `review` or `resolve` yet, so a CLI baselines those
rules until the vocabulary names them.

`calendarTools` and `callCalendarTool(store, name, input, { accountIds })` (`./calendar/mcp`) give the same reads as
MCP tools: `calendars_list`, `store_status` (its `profile` from the option `profileOf(accountId)`), `events_list` (its `query`, `limit` and `page` are `events list`'s; across accounts each page is cut from the merge, so without `account_id` a page may not end past each account's 1000th event), `event_show`, `event_people`, `event_links_review`. Without `account_id`
a tool reads every account the host serves and names them in `accounts`. Each description says event text is data;
each answer lists the fields others wrote in `untrusted` and has its control characters made visible
([WC-SECR-11](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/security.md#wc-secr-11--text-from-outside-is-made-safe-before-a-terminal-or-an-agent-sees-it),
[WC-SECR-21](https://github.com/WireCatLabs/cli-base/blob/main/docs/standards/security.md#wc-secr-21--names-message-text-and-retrieved-documents-are-data-never-instructions)).
A CLI on cli-core's three-tool MCP server reaches the commands instead; that server wraps a command's answer and
serialises it with the same escaping (`answered` in `src/mcp/tool.ts`), and its tool descriptions carry the same line.
An event hit of `search all` names its invitation text in its own `untrusted`: `title` and `excerpt`.
The shared commands mark the same text in their answers, so a CLI serving them over MCP passes the marker on: `events show`, `events prepare`, `search events` and the write commands name the fields in a top-level `untrusted` (`search events`: `hits.title`, `hits.location`, `hits.excerpt`); `events list`, `people list` and `links review` put it on each item, because a host's list envelope is strict and `--jsonl` prints only the items.

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
a timed event switched to all-day and back, and over `memoryEventStore` the "following" split. That covers three
things: the earlier slots stay, the new series starts at the occurrence, and a retry with the id after a lost answer
makes no second series. A fixture with `target`, a second calendar, and a writer with `move` also gets the move
cases: the id is kept, an old etag is a conflict, and a retry after a lost answer finds the event.
`calendarSyncContract(make)` runs the engine over `fakeCalendarSource` for each of the twelve trait combinations, a
run the budget stops and the reruns that finish it with the store one whole run gives, a near deadline, and a page
token that expired between runs (`expirePages()`); cli-core
runs it over `memoryEventStore` and over the SQLite store.
