# Meetings

`src/meetings/`, exported as `@wirecat/cli-messaging/meetings` (and `/meetings/cli`, `/meetings/mcp`,
`/meetings/testing`); up to 0.4.2 it was the separate package `@wirecat/cli-meetings`. Each meeting provider
is its own package that implements `MeetingSource`; the shared store implements `MeetingStore`; this module
owns everything between them.

## Events and meetings

An **event** is the owner's own record of something that happened, as a **person** is the owner's own
record of someone. A **meeting** is what one external app knows about it: a Zoom occurrence, a
Fireflies recording. Several meetings can point at one event, as several identities point at one
person. Later a calendar entry points at the same event.

```text
persons ◄── identity_links ── identities (a Zoom user, a Telegram user, …)
                                   ▲ meeting_participants
event_series ◄── events ◄── meetings ── transcripts → utterances, chat, summaries, documents
                     ▲
                     └── later: calendar entries
```

## Who depends on whom

```text
cli-base ← cli-messaging (src/meetings/ ← the rest of src/) ← zoom-cli (zm)
```

- **`src/meetings/`** — the model, the WebVTT parser, source and store ports, and what runs on them: pull,
  import, event linking, commands and MCP reads. Optional provider ports add meeting management,
  recording transfer, archive synchronization and schedule planning. No SQLite, no filesystem and no import
  from the rest of the package: the lint rules in [`biome.json`](../../biome.json) refuse them under `src/meetings/`.
- **the rest of cli-messaging** — the tables, in its single list of store migrations, and `MeetingStore` over
  SQLite, as it does for the `TaskStore` of `src/tasks/`. It also owns bounded durable evidence, person context,
  embedding bindings and semantic services that depend on the shared knowledge store.
- **A provider** (`zoom-cli` first) — login, the API client, and one `MeetingSource` per way in: `api`,
  `files`, `browser`. It opens the shared store through cli-messaging and hands both ports to the
  meetings commands.

## The modules

| File | What |
|---|---|
| [`src/model.ts`](../../src/meetings/model.ts) | events, meetings, participants, transcripts, chat, summaries and attachments |
| [`src/vtt.ts`](../../src/meetings/vtt.ts) | `parseVtt`: WebVTT cues to transcript lines, the speaker taken from `Name: text` |
| [`src/store.ts`](../../src/meetings/store.ts) | `MeetingStore`, atomic writes and meeting/event reads |
| [`src/source.ts`](../../src/meetings/source.ts) | `MeetingSource`, the port a provider implements |
| [`src/pull.ts`](../../src/meetings/pull.ts) | fetch occurrence parts and save them |
| [`src/import.ts`](../../src/meetings/import.ts) | parse files supplied by the caller |
| [`src/events.ts`](../../src/meetings/events.ts) | preserve links, match or create an event |
| [`src/cli/index.ts`](../../src/meetings/cli/index.ts) | Commander commands |
| [`src/mcp/index.ts`](../../src/meetings/mcp/index.ts) | schemas and read dispatcher |
| [`src/testing/index.ts`](../../src/meetings/testing/index.ts) | memory store, fake source and contract cases |
| [`src/provider.ts`](../../src/meetings/provider.ts) | fixed opaque provider/account scope |
| [`src/meeting-management.ts`](../../src/meetings/meeting-management.ts) | optional remote read/write ports, portable validation and explicit mutation dispatch |
| [`src/recording-source.ts`](../../src/meetings/recording-source.ts) | provider-neutral recording catalog and asset metadata |
| [`src/recording-transfer.ts`](../../src/meetings/recording-transfer.ts) | bounded transfer and strong-validator resume over source/storage ports |
| [`src/recording-sync.ts`](../../src/meetings/recording-sync.ts) | discovery windows, archive acknowledgements and checkpoint orchestration |
| [`src/recording-schedule.ts`](../../src/meetings/recording-schedule.ts) | pure schedule definitions and explicit host scheduler installation |

These capabilities compose independently of `MeetingSource` and `MeetingStore`; their existing
contracts remain unchanged. A provider can supply recordings without mutation support, or remote
management without transcripts. Provider IDs and accounts stay opaque. Provider-specific meeting
types, HTTP request bodies and credentials never enter the shared SDK. Host adapters own filesystem
safety, URL trust, authentication and OS timers. See [provider integration](MEETING-PROVIDERS.md).

The stored model follows the shared store schema: integer ids, epoch millisecond timestamps,
`metadata` for provider extras, and transcript rows keyed by transcript and position. Source data
uses separate types until the store assigns ids.

## The tables

In the shared store, created by cli-messaging. Times are epoch milliseconds. Every table that holds a
provider's record has `metadata`, JSON, for whatever has no column yet.

| Table | One row is |
|---|---|
| `events` | the owner's event: title, start, end, time zone, whether a pull or the owner made it |
| `event_series` | a repeating event, above any one provider's recurrence |
| `meeting_series` | a provider's recurring or scheduled meeting: title, kind, recurrence, host, join link |
| `meetings` | one occurrence: start, end, duration, host, and the event it belongs to |
| `meeting_participants` | one person in one meeting: their identity, the name and email shown in that meeting, role, joins and leaves |
| `meeting_transcripts` | one transcript of a meeting: its source, format, language and content hash |
| `meeting_transcript_rows` | one line of a transcript: start, end, speaker, text |
| `meeting_chat_messages` | one message of the in-meeting chat |
| `meeting_summaries` | one summary: title, overview, sections, next steps, the full text, which tool made it |
| `attachments` | one file a meeting has: a recording, a shared file, a whiteboard — a pointer, not the file |

Meeting text gets its own word and stem indexes, built the way the notes' are, so a query means the same
for messages, notes and meetings.

## Rules the tables keep

1. **Nothing is lost.** A pull never deletes. What a provider stops returning is marked gone; a
   transcript whose text changed is a new transcript, and the old one stays.
2. **A participant is an identity, not a contact.** Keyed by the provider's user id, else email, else a
   name that counts only inside its meeting, so two strangers with one name never merge. The name shown
   in each meeting stays with that meeting. A contact is someone with a one-to-one chat, which a meeting
   never creates; the owner links a participant to a person when it is the same human.
3. **Sources point at events; events point at nothing.** That is what lets a calendar, or a second
   meeting app, join later without changing the meeting tables.
4. **Meetings are not messages.** Messages are for messengers; meetings, their lines and their chat live
   in their own tables.

## Atomic writes

`saveMeeting` takes the occurrence and its available parts in one call, keyed by account and external
id. The store assigns ids and resolves participant identities in the same transaction. Speaker
positions refer to the participants in that save. Omitted parts retain existing data. Changed
transcripts add a version and supersede the prior version from the same source; identical hashes
skip re-import. Automatic linking preserves existing event links. Cursors are scoped to accounts.

## Adapter contract

[`src/testing/index.ts`](../../src/meetings/testing/index.ts) exports the memory adapter, a fake provider,
invented samples and `meetingStoreContract(make)`. Every case gets an empty adapter; the caller owns
its lifecycle. Cases cover retained history, idempotence, account isolation, identity matching,
ambiguous speakers, atomic failure, search, filters, event linking and cursors. The memory adapter
uses substring search to exercise the port; it does not implement the production word/stem index.

## Ingestion

`pull(source, store, { accountId, since, now, lookbackMs })` reads participants, transcript, chat, summary and files
in order for each occurrence, then saves and links its event. Missing parts remain unknown; a failed
occurrence produces a warning, processing continues, and the cursor stays unchanged so it can retry.
Discovery failures reject the pull before any occurrence is processed. A successful pull advances
its account cursor to `now`, even when some parts are unavailable (`null`). By default this cursor
only covers occurrence discovery; it does not guarantee that transcripts appearing later will be
fetched. Callers can supply an explicit `lookbackMs` (integer milliseconds, zero through 31 days) to
subtract from the selected `since` or stored cursor, revisiting a bounded discovery window. Its default
is zero. Parts that appear outside the window require an older explicit `since`.

The source reports whether its series is recurring. Participants carry identity keys; a cue matches
only one participant with that name. Name clashes preserve the cue's name with a null speaker link.

`importFiles` takes file contents and meeting metadata supplied by the caller. It reads no folder.
SHA-256 hashes skip repeated transcript content; corrected versions supersede only the same source.
`linkEvent` preserves existing links, matches overlapping series or join links, and creates an event
when no single match exists. Recurring meetings also create an event series when needed. Linking refreshes the stored meeting
first and reads back its actual link after automatic linking, preserving a concurrent owner update.
Event creation and linking are separate store calls: concurrent callers can still create unused
events or event series. The current port cannot guarantee atomic event selection, creation and linking;
callers should serialize ingestion for the same account. A join-link match does not automatically
merge the incoming provider's recurring series into the matched event series. Stronger atomic and
series inheritance guarantees require coordination with the SQLite adapter.

## Delivery

[`src/cli/index.ts`](../../src/meetings/cli/index.ts) mounts Commander commands on a host program. Dependencies
supply the selected account, store, source, file reader, output writer and clock. Show and transcript
are scoped to that account. `meetings sync` runs `pull` and exposes `--lookback-days <days>`, an integer
from zero through 31 (default zero), forwarding days as `lookbackMs`. It subtracts from the selected
boundary, including an explicit `--since-time`; invalid bounds fail before provider discovery. Groups have no default action. The host owns rendering and exit codes.

[`src/mcp/index.ts`](../../src/meetings/mcp/index.ts) exports JSON schemas, read annotations and a dispatcher
for the meeting read tools. The server owns registration and access policy. Arguments use snake case
and are checked before execution. Results include JSON text and structured content; errors set
`isError`. Both surfaces use [`src/reads.ts`](../../src/meetings/reads.ts), including the list page envelope.

## Providers next

Moved from cli-meetings' roadmap when that repository was retired. Zoom, through `zoom-cli` (`zm`), is the
first provider. Each one below is a source behind the same port; nothing above the port changes when one
is added.

- **Google Meet** — transcripts and recordings from Google Workspace.
- **Microsoft Teams** — transcripts and meeting chat through Microsoft Graph.
- **Meeting-assistant bots** that already transcribe and summarise — Fireflies and similar services —
  read through their APIs as one more source.
- **A browser source** for Zoom, for accounts whose admin does not approve the app and for meetings the
  user only attended.
- **Later, calendars** — Google Calendar and others. A calendar entry is one more source for an event,
  next to the meetings: it points at the same event, its invitees are identities like meeting
  participants, and a recurring entry points at the same event series. Nothing for calendars is built
  yet; the event tables are shaped so that adding them changes no meeting code.

## Bounded search with context filters

`meetings.searchHits` combines account and date bounds with `participantIdentityId`, `personId`, `eventId`, `meetingSeriesId`, `projectId` and `tagId` before hit pagination. Event and series are field predicates on the meeting, beside the others; the query itself is plain words, not a Lucene query. Participant identity matches observed meeting membership; person matches follow existing identity links. Neither attributes transcript speech. Project selection requires a confirmed, unanchored membership link to a live owner project. Tags and topics use explicit meeting taggings. Proposed project membership does not count.

`searchMeetingHits` from the services export also takes `project`, `tag` or `topic` names. It reuses the shared vocabulary's exact canonical-name, project-key and explicit-alias resolution; missing or ambiguous names fail with candidates instead of guessing. Results include the resolved name selections. It does not infer project membership from transcript words or write labels. Cursors bind the resolved IDs together with the account, query and dates. Before it reads, `searchMeetingHits` indexes what was saved since the last search (`refreshMeetingIndex`), in batches that each commit, so there is no separate index step; when the store's stemmers are unknown it indexes words only.

Providers mount `addMeetingSearchCommand` from the meetings CLI export: it adds `search meetings` under the host's `search` group (creating it when missing) and returns the command, so a host can add options and pick another source from them. Its `search` closure is fixed to the selected account and receives the request and every parsed option. The optional `meetingSearchTool` (`search_meetings`) and `callMeetingSearchTool` from the meetings MCP export accept the same selectors; tool callers cannot override that account. Hosts retain permission checks, connection lifecycle and output limits.

Search coverage remains explicit: an empty page does not prove the archive is complete, and pending indexing can hide matches. Human-name participant disambiguation, discovery by project words without explicit membership, hit-centered evidence and compact cited passages remain separate work.
