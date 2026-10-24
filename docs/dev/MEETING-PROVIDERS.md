# Provider integration

The SDK exposes separate capabilities rather than a mandatory provider base class. Existing
`MeetingSource` defines ingestion; `MeetingStore` defines persistence and account ownership metadata. Zoom supplies the first
production adapter; the providers below are invented fixtures, not available Meet or Teams clients.

## Choose capabilities

| Capability | Shared orchestration | Host implementation |
|---|---|---|
| `MeetingManagementPorts` | `createMeetingManagement` validates portable changes and controls explicit writes | account-bound API list/get/invitation/create/update/cancel methods |
| `RecordingCatalog` | `syncRecordingArchive` bounds date windows, pagination and progress | provider recording discovery and opaque cursor handling |
| `RecordingTransferSource` | `transferRecording` validates byte limits, response ranges and strong validators | trusted HTTP endpoint, authentication, redirects and response streams |
| `RecordingTransferStorage` | transfer acknowledgement and resume coordination | safe partial files, prefix hashing, atomic publication and retained partial metadata |
| `RecordingSyncCheckpointStore` | exclusive lease and revision-based checkpoint writes | durable storage and cross-process ownership checks |
| `RecordingArchiveScheduler` | schedule validation, preview and explicit installation | OS timers or another host scheduler |
| `MeetingContextPorts` | validates notes, tags, memories and explicit event/person changes; previews by default | shared knowledge records, account ownership and durable evidence checks |
| `MeetingContextStore` | typed event and participant link receipts | atomic scoped ownership, compare-and-set and identity association audit |
| `MeetingReadCapabilities` / `MeetingContextReadCapabilities` | bounded metadata, transcript pages and atomic cue-centered snapshots | account ownership, read-byte preflight and revision-aware reads |
| `MeetingPreparationContextStore` | bounded context for a selected occurrence, without accepting findings | shared stored person/project links, accepted facts and directly sourced tasks |
| `MeetingRelatedHistoryStore` | bounded other-series history through explicit people/confirmed project links | same-account, dated live meeting metadata and independent lookahead |
| `createMeetingPreparationService` | selected upcoming proof, exact-series and related history with cited local context | bind the authorized numeric account, shared store and account-bound upcoming reader |
| `MeetingParticipantSearchStore` | shared CLI/MCP participant discovery and continuation steps | account/query-bound candidate pages, Unicode literal matching and read budgets |
| `readMeetingProjectDiscovery` | one bounded canonical/key/alias page with cited unconfirmed evidence | the existing vocabulary resolver and account-scoped `MeetingSearchStore`; no provider-specific project catalog |
| Project-evidence CLI/MCP adapters | query validation, complete registered entity and frozen continuation | an account-bound `MeetingProjectDiscoveryReader`; host owns lifetime and final output limits |
| `MeetingSearchStore` | bounded hit pages with opaque continuation and coverage | seek pagination, read budgets and account/query-bound cursors |
| `MeetingSearchIndexStore` | explicit bounded maintenance receipt | scoped pending rows and transactional byte-bounded indexing batches |
| `MeetingTranscriptReceiptStore` | exact append outcomes | counts and writes in one transaction, including historical replay |
| `MeetingTranscriptionSource` | bounded recognition segments, provenance and one explicit append | ordinary media files, decoding and an already installed local model |

No capability requires the others. A read-only assistant can expose `get` without recordings or
writes. A recording service can implement a catalog and transfers without managing meetings.
The SDK contains no filesystem, database, vendor client, credentials or automatic provider setup.
cli-core implements the durable meeting store and its evidence/context/semantic services.

## Stored meeting reads

Import the read interfaces from `@wirecat/cli-core/meetings`. A provider using the shared SQLite
store already receives these capabilities; it should not implement another participant index or
transcript-window formatter. Existing store-entry imports of read contracts remain aliases.
A custom `MeetingStore` implements `account(id)` as well as meeting reads: return the provider
and account label for that stored account, or `null` when absent. List items use this metadata
for shared references and cannot be rendered with a guessed owner. Labels do not authenticate users.

Mount `addMeetingCommands` with an already authorized account ID. The host owns connection
lifetime, deadlines, output limits and run metadata. `meetings list [query...]` validates metadata
filters through the shared query registry and returns shared meeting entities in the list envelope.
The generic MCP adapter accepts equivalent queries; a provider host fixes/removes `account_id`
from caller arguments before dispatch, as Zoom does. Never expose another account through a cursor.

The optional `participantCandidates(query, options)` port reads only observed IDs, names and emails;
it never requires session history or transcript text. Enforce `limit`, `scanLimit`, `maxReadBytes`
and cancellation, and check stored text sizes before loading them. Cursors bind the selected
account and normalized literal query. An empty scan page may still have continuation; edits and
deletions between calls do not form an immutable archive snapshot.

The raw store packet reports `has_more` / `next_cursor`; `meetingPeople` and the shared CLI/MCP
adapters adapt it to `page.limit`, `page.has_more`, optional `page.cursor` and `page.next`.
Preserve that whole answer in JSONL so an empty page does not erase its cursor or coverage.
Page-local identity ambiguity is evidence to review, never speaker attribution or a person link.
A capable store requires an account; older stores retain default legacy reads and refuse explicit
paging options. Use the atomic cue-context port and shared passage formatter for cited context,
rather than reconstructing transcript windows in each provider.

## Exact stored series history

`MeetingSeriesHistoryStore` is an optional read capability, separate from `MeetingStore`. The shared
SQLite store implements it as `store.meetings.seriesHistory({ accountId, externalId, after, before,
limit?, maxReadBytes?, signal? })`. The host selects the authorized numeric store account; `externalId`
is the exact provider series key, not an occurrence ID, title, person name or account label.

The half-open `[after, before)` window uses absolute epoch milliseconds. Defaults are 20 rows and
256 KiB of stored text; hard limits are 100 rows and 4 MiB. The text budget includes the selected
series and occurrence titles/IDs, including one lookahead row, before values are loaded in the same
read snapshot. Returned metadata excludes descriptions, URLs, provider metadata and transcripts.
The row limit bounds hydration, not the database's work finding and ordering eligible occurrences.

Results contain a compact `series` or `null`, `items` ordered by start descending then internal ID
descending, `hasMore`, and `hasUndated`. Soft-deleted series and occurrences are excluded. An empty
window differs from a missing series. Undated occurrences are reported separately because they
cannot be assigned to the window. A full page is only stored history; it establishes neither archive
completeness nor attendee identity. Reads leave search queues untouched and perform no writes.

This capability supports preparation services; it adds no preparation CLI/MCP command. Reuse
bounded transcript evidence and explicit people/project links when composing a brief. Do not call
legacy full-detail hydration for every occurrence or derive membership from matching titles.

## Remote management

```ts
import { createMeetingManagement, type ManagedMeeting } from "@wirecat/cli-core/meetings"

const example: ManagedMeeting = {
  id: "opaque/meeting:a", title: "Alice Example planning", kind: "scheduled",
  startTime: "2026-10-11T10:00:00Z", durationMinutes: 30, timezone: "Europe/Madrid",
  agenda: "Bob Sample agenda", joinUrl: null,
}
const calendar = createMeetingManagement(
  { provider: "example-calendar", account: "Alice Example" },
  {
    get: async (id, context) => ({ ...example, id }),
    create: async (change, context) => ({
      ...example, id: "opaque/new:a", title: change.title ?? null,
      kind: change.kind ?? null, startTime: change.startTime ?? null,
    }),
  },
)
const assistant = createMeetingManagement(
  { provider: "sample-assistant", account: "Bob Sample workspace" },
  { get: async (id) => ({ ...example, id }) },
)
await assistant.get("{opaque-uuid}")
const preview = await calendar.create({ title: "Example now", kind: "instant" })
const receipt = await calendar.create({ title: "Example now", kind: "instant" }, { apply: true })
```

Only supplied ports appear in `capabilities`. An unsupported operation fails with
`provider_unavailable` before any provider work. Scope is a detached frozen `{ provider, account }`
snapshot, passed to every port through `context.scope`; caller options cannot replace it. Bind each
adapter's token manager to that account when constructing its ports. An account label alone does not
authenticate a user. IDs remain opaque; numeric ID rules belong to providers that require them.

Portable changes use `title`, `kind` (`instant` or `scheduled`), `startTime`, `durationMinutes`,
`timezone` and `agenda`. Creation defaults to scheduled and requires a start timestamp; instant
creation does not. Timestamps require an explicit offset or Z and normalize to UTC; invalid calendar
dates are refused. Duration accepts integer minutes from 1 through 1440. Timezone accepts an IANA
zone. Adapters map these fields into their own API bodies and handle provider limits.

Mutations return `applied: false` by default and call no port. Literal `apply: true` dispatches once;
`dryRun: true` overrides it. Cancellation before dispatch prevents a write. After dispatch, the
adapter must distinguish confirmed success from `outcome_unknown`; the SDK preserves its error and
never retries. Common errors extend cli-base `CliError` and keep its codes. HTTP status translation
and provider-specific error details remain in the host adapter.

## Recording transfer and archive jobs

`RecordingAssetLocator` uses fixed provider/account scope and opaque occurrence/asset IDs, never a
download URL. The host source turns that locator into a trusted authenticated request. Transfer
enforces `maxBytes`, an optional expected size and validated range/length responses.

A partial is resumable only with a strong ETag, matching locator and valid prefix metadata. The host
must verify the prefix digest and file identity before returning it from `storage.load`. Weak ETags
and missing validators cannot authorize byte append. A changed representation or ignored range
starts a fresh transfer. The host must preserve an already verified final file and atomically publish
new bytes only after success. The shared SDK does not inspect paths or follow redirects itself.

`syncRecordingArchive(catalog, options)` takes an explicit `archive(occurrence, signal)` callback.
It partitions validated dates into monthly windows, bounds pages and entries, and yields completed
archive receipts. Optional checkpoints store pending windows and per-asset acknowledgement
fingerprints. The checkpoint store owns an exclusive job lease and compares revisions on save.
Its configuration key must identify the host's destination and relevant archive policy, so another
account or destination cannot silently reuse progress.

Checkpoint acknowledgement means an earlier archive callback completed; it does not recheck current
file integrity. Completed windows do not guarantee all provider recordings existed or were
available. A receipt deliberately reports `availability: "unknown"`. Use `recheckFrom` to revisit
recent windows for late recordings. Checkpoints hold identifiers and neutral metadata, not URLs,
tokens, transcript content or a claim of global archive completeness.

## Daily schedule planning

```ts
import {
  installRecordingArchiveSchedule, planRecordingArchiveSchedule,
  recordingArchiveScheduleWindow,
} from "@wirecat/cli-core/meetings"

const schedule = planRecordingArchiveSchedule({
  name: "Alice Example backup", scope: { provider: "example-video", account: "Alice Example" },
  destination: "/example/archive", from: "2026-10-01", dailyAt: "03:00",
  timeZone: "Europe/Madrid", lookbackDays: 7,
}, { now: Date.parse("2026-10-11T00:00:00Z") })
const window = recordingArchiveScheduleWindow(schedule, { now: Date.parse("2026-10-12T00:00:00Z") })
const preview = await installRecordingArchiveSchedule({
  backend: "example-scheduler", install: async () => {},
}, schedule)
```

Planning and window selection are pure and take the clock as an argument. A schedule stores the
selected scope, destination and limits without credentials or shell commands. Installation previews
by default; `{ apply: true }` calls the host scheduler once. The host persists the definition,
translates the daily local time into an OS timer, invokes archive jobs and handles uninstall/status.
The SDK neither installs a service nor chooses an OS scheduler. Daily time uses the selected IANA
zone; the discovery window uses UTC dates and a bounded recent lookback.

## Owner context and local transcription

`createMeetingContext(scope, accountId, ports)` captures the provider/account label and numeric
store account. Its `change` method previews by default; `apply: true` dispatches once and `dryRun`
overrides application. The store adapter checks ownership and evidence when writing. Scope labels
are not authorization. Participant association moves the chosen identity only; names never authorize
person merging. A target person observed in another account needs explicit selection of that account.

`transcribeMeeting` describes selected media on preview and runs recognition only on explicit apply.
Native hosts verify file identity and content, decode bounded chunks and use installed models without
implicit downloads. Coarse timestamps use `recognition.timing: "fixed-windows"`; they do not claim
word alignment or speaker recognition. Local sources are separate from provider transcripts and
retain model/media provenance. A failed or cancelled recognition never appends partial rows. The
existing target is appended atomically; no occurrence is created from guessed meeting metadata.

`indexSearch` maintains a bounded pending batch explicitly; raw `searchHits` paging never drains queues.
The higher-level `searchMeetingHits` service refreshes pending batches before reading. Hosts that
require reads without index writes should bind the raw port and state that coverage can be pending.
Hit continuation bounds rows inside one meeting. Its coverage reports pending indexing and unknown
archive completeness. It is a live view, not a snapshot across modifications between calls. Exact
append receipts do not imply bounded legacy meeting-history hydration in a producer adapter.

## Native file and WAV helpers

Native connectors can import `openOrdinaryFile` and `syncDirectory` from
`@wirecat/cli-core/files`, and `preflightWavAudio` and `openWavAudio` from
`@wirecat/cli-core/speech/wav`. These host helpers sit outside the pure meeting module and
import no store, provider or speech engine.

WAV preflight takes explicit byte and duration budgets (at most 4 GiB and 24 hours), validates PCM16
mono/stereo at 16 or 48 kHz, and hashes the complete file. Its frozen plan omits the path and must
stay in the same process: reconstructing it from JSON is refused. Opening verifies file identity,
layout and content again; a single-use iterator produces at most 30 seconds of 16 kHz mono samples
per window. Consuming the entire iterator verifies the bytes read against the preflight hash.
Close the source in a `finally` block, and commit recognition only after successful completion.
Neither helper installs a model or converts compressed audio/video.

`openOrdinaryFile` rejects a symlink at the selected path and verifies ordinary-file identity before
returning its read handle; callers close that handle. Directory syncing persists POSIX publication
entries and propagates failures; Windows returns without directory syncing. Hosts remain responsible
for trusted parent directories, destination names and provider-specific publication journals.

## Verify adapters

The testing entry point exports runner-independent contracts using invented fixtures:

- `meetingStoreContract` and `meetingTranscriptStoreContract` verify durable ingestion and history.
- `meetingManagementContract` verifies previews, explicit single writes and cancellation. Its factory
  must supply invented meetings and injected transports because cases can apply writes.
- `recordingTransferStorageContract` verifies partial identity, acknowledgement and prefix behavior.
- `recordingSyncCheckpointStoreContract` verifies empty state, reopen, lease ownership and revision
  checks. The memory checkpoint store supports pure orchestration tests; it is not durable storage.

Each contract case exposes `{ name, run }`. Give each case a fresh fixture and keep filesystem tests
inside an isolated temporary home. Test the host's URL trust, token selection, filesystem races,
cross-process locks and OS scheduler separately; the pure SDK cannot establish those guarantees.

## Upcoming occurrence reads

`createUpcomingMeetingReader(scope, port)` is a read-only SDK foundation for one selected provider
meeting or recurring series. It does not discover the owner's next meeting across a calendar or
build a preparation brief. The provider/account scope and port are captured when the reader is
created. `next(meetingId, {after, until, limit?, maxReadBytes?, signal?})` uses absolute epoch
milliseconds and a half-open `[after, until)` window. Defaults are 100 normalized entries and
1 MiB; hard limits are 1000 entries and 4 MiB. Invalid requests fail before provider I/O.

The provider supplies a `MeetingOccurrenceSchedule`: its meeting ID, single/recurring/unscheduled/
unknown kind, optional IANA timezone, explicit occurrence entries and completeness/missing-capability
status. Recurring verified entries require occurrence IDs; a series start date alone is insufficient.
Keep provider date parsing and wire-response byte limits in the adapter. The shared reader validates
the detached normalized answer, its UTF-8 budget and row count, then selects the earliest active
candidate within the window. It never retries a provider failure or performs a write.

`candidate` can be useful even when `verifiedNext` is false. A verified-next claim requires a
verified candidate, a complete schedule for this selected series/window, no active unverified entries
and no simultaneous candidate ambiguity. Cancelled entries are excluded. Missing detail access is
represented by an incomplete schedule and `missing` capabilities; do not start login or change app
settings. Completeness here does not establish full calendar coverage or identify attendees.
The result retains inspection, cancellation, undated and unverified counts. `coverage.simultaneous`
counts candidates at the earliest eligible instant: zero for no candidate, one normally, and more
than one for an ambiguous selection. Late cancellation
refuses the result. Importing this SDK never opens a provider, database or model.

The SDK has normalized synthetic provider proofs. The
[preparation SDK](MEETING-PREPARATION.md) composes a selected upcoming series with bounded stored
context. Hosts can opt in to the registered answer entity and shared CLI/MCP preparation adapters
from `./cli`; see that guide for mounting and resource ownership. Broad calendar discovery and
reviewed findings intake remain separate work. Core does not mount provider commands automatically.

## Reverse project suggestions from supplied evidence

`createMeetingProjectCandidateReader` from `@wirecat/cli-core/services` captures a provider/account,
a numeric store account and a narrow `vocabulary` reader. Its input and output types are exported
from `/meetings` and `/services`. It suggests existing global projects from evidence already selected
by the host. It does not search all meeting history, infer membership or write a project link.

```ts
import { createMeetingProjectCandidateReader } from "@wirecat/cli-core/services"

const suggest = createMeetingProjectCandidateReader(
  { provider: "example-calendar", account: "AliceExample" },
  selectedAccountId,
  { vocabulary: store.knowledge },
)
const candidates = await suggest({
  reference: `meeting:${selectedAccountId}/${meetingId}`,
  title: "Harbour Example planning",
  cues: evidence.items.map(({ reference, fingerprint, text, revision }) => ({
    reference, fingerprint, text, revision,
  })),
})
```

The host authorizes and hydrates that source before calling the SDK. Supplied cue fingerprints and
revision markers are retained, not revalidated against stored transcripts. Evidence must belong
to the selected account and parent meeting. The reader detaches input before asynchronous I/O and
never broadens selection. No input changes the captured provider/account or vocabulary grant.

Defaults/hard maxima: one project vocabulary call, 128 projects, 64 KiB of catalog names/keys/aliases,
ten candidates, 100 supplied cues, 65,536 characters per cue, 8,192 per title and 64 KiB of supplied
text in total. References and fingerprints have separate fixed bounds. `limit`, `maxProjects` and
`maxVocabularyReadBytes` can lower these bounds; `bytes` defaults to 16 KiB and takes 1–64 KiB for
the serialized SDK packet. Catalog over-budget errors remain explicit refusals; they never become
an empty match result. Select a known project for existing project-evidence search when the
catalog exceeds the bounded grant; this SDK does not silently sample the first projects.

Matching uses NFKC, lowercase and collapsed whitespace, preserving accents and literal punctuation.
Unicode letters, numbers, combining marks and underscores define word boundaries. This is neither
stemming nor semantic similarity: `año` differs from `ano`, and `HAR` does not match `HARBOR`.
No model or download is needed. Candidates use stable numeric project-ID order, not confidence
ranking. The same normalized term belonging to multiple projects stays ambiguous, even when an
output limit hides one. Repeated cue references/normalized aliases do not multiply support;
conflicting data for the same cue reference is refused.

Each candidate retains its canonical project reference, matched term/alias ID and separate
`metadata-title` hints or transcript references/fingerprints/revisions. At most twenty matches
per project are returned, with `omittedMatches` counting additional matches. Coverage also retains
the total omitted-match count when output projection hides per-project details. `association` and
coverage retain unconfirmed status and unknown archive completeness. Input and vocabulary
fingerprints let a caller detect changed evidence or catalog versions; no continuation snapshot
or accepted finding is implied. Output trimming removes whole candidates, retaining mandatory
coverage, total candidates, `hasMore` and `outputLimited`; increase bytes or narrow explicit input
rather than treating omitted projects as absent. If mandatory provenance cannot fit, the reader
refuses the byte limit. This SDK is not added to preparation or exposed as a CLI/MCP tool by itself.


## Reverse project suggestions from stored meetings

`createStoredMeetingProjectCandidateReader` from `/services` adds authorized, bounded hydration over
the supplied-evidence SDK. Pass the captured provider/account, numeric account ID, bounded
`meetings` read capabilities (including `account`) and `vocabulary`. It verifies the stored owner
before reading metadata or transcripts. It never opens a provider connection or writes to the store.

The reader uses the existing meeting evidence service: one transcript page, up to twenty cues by
default (maximum one hundred), a 32 KiB cue packet and at most 64 KiB stored text per read. A fixed
eight-call store budget also bounds custom readers returning partial pages; the separate global
project catalog remains one read of at most 128 projects and 64 KiB. Exceeding a read bound refuses
explicitly. Metadata is read once; the title is captured before transcript I/O. Reads are live, not
one transaction or a frozen archive snapshot. The SDK result retains the evidence fingerprint,
read limits, skipped revisions, continuation and unknown archive completeness alongside candidate
provenance. Its output budget includes that metadata and removes whole candidates when needed.

`addMeetingProjectCandidatesCommand`, `readMeetingProjectCandidates`,
`meetingProjectCandidatesTool` and `callMeetingProjectCandidatesTool` are exported from `/cli`,
following the existing preparation adapters. The host injects the stored reader and owns resource
closure. The command mounts under an existing `meetings` group:

```text
example meetings projects scan meeting:1/2 --cues 20 --bytes 16384 --json
```

The raw MCP tool is `meeting_project_candidates`, with `ref`, `limit`, `cues`, `bytes`,
`max_read_bytes` and `cursor`. Both adapters validate unknown fields and name the field in a
`validation_error` before calling the host reader. Success is an item envelope with execution
`meta`; the registered `meeting_project_candidates` entity and every nested field use snake_case.
`meta.truncated` reports bounded candidate output or more evidence, while `meta.complete` reports
read issues; neither asserts a complete archive. `bytes` bounds the item JSON, separately from the
host's envelope/rendered-output budget. MCP errors preserve the host's supplied failure context.

Resume with `item.evidence.coverage.next_cursor` and the same parent `ref`. A cue cursor continues
within a revision; a transcript cursor continues after a fully read revision, including an empty
one. The next page rematches the title and selected evidence against the live project vocabulary;
project IDs may repeat between pages. Fingerprints can change between calls. Candidate omission
is separate from evidence continuation: increase `limit`/`bytes` to retain more matched projects,
and use the evidence cursor to examine more transcript cues. A null cursor with byte-truncated
zero cues means a single cue did not fit the fixed evidence budget; it is not proof of no match.

Provider hosts must opt in to the global vocabulary grant explicitly. Base registers
`--meeting-project-candidates`; it does not mount the tool on its own. The SDK and adapters add no
preparation default or remote provider transport. Confirm a suggested project link through the
existing reviewed finding workflow; a title match or alias collision never confirms membership.


## Bounded series inventory

`createMeetingSeriesInventoryReader` from `/meetings` captures a provider/account and a narrow
`MeetingSeriesInventoryPort`. The port reads exactly one bounded page; it must not call a full-array
management API and slice its result. The SDK validates the request before I/O, captures its values,
passes a frozen scope/window/read budget, validates and detaches the returned candidates, and never
loops over pages. No database, migration, credentials or provider implementation is added here.

Call `page({after, until, limit?, maxReadBytes?, bytes?, cursor?, signal?})`. Times are absolute
milliseconds, with an increasing window of at most 366 days. Defaults are one hundred candidates,
64 KiB normalized provider-page bytes and 64 KiB result JSON bytes. Hard maxima are one hundred
candidates and 1 MiB for either byte budget; the result budget has a 2 KiB minimum. Titles are
nullable and at most 8,192 characters; IDs and raw provider cursors are bounded identifiers. A
returned cursor must also fit the 4,096-character public cursor budget. Input bytes bound the
normalized DTO; transport adapters must separately bound HTTP response reading before JSON parsing.

Each candidate has an exact provider `meetingId`, nullable title, schedule kind and nullable
`scheduledStartAt` hint. No join URL or source permalink is accepted. Old recurring start dates,
undated entries and hints outside the requested window are retained and counted. Inventory hints
never prove the next occurrence: after selecting the exact ID, call `createUpcomingMeetingReader`
with the same captured scope and window. Do not choose a series by a similar title alone.

Coverage distinguishes a provider-window selection from a provider inventory, retains partial
source status and `hasMore`, and always says `calendarCompleteness: "unknown"` and
`occurrenceProof: "not-read"`. A terminal provider page does not prove that every calendar or
permission scope was searched. Empty pages with continuation remain resumable; permission errors
propagate and never become empty successful pages. Oversized input/output pages refuse without
silently dropping candidates or advancing a page; lower `limit` or raise the appropriate byte bound.

Continue with the returned opaque cursor and the same provider/account and absolute window.
The cursor binds this selection and carries only the provider continuation, not credentials or
an authorization grant. The adapter must enforce the captured scope on every request. Repeated
non-advancing provider cursors are rejected. Caps may be lowered on a later page. Pages are live;
IDs can repeat across pages and fingerprints describe only the returned packet. No snapshot or
whole-calendar completeness is implied. Optional shared CLI/MCP adapters are described below. Provider transports and an explicit host
grant remain required; the SDK does not widen an existing server's tools.


## Inventory CLI and MCP adapters

`addMeetingSeriesInventoryCommand`, `readMeetingSeriesInventory`, `meetingSeriesInventoryTool`
and `callMeetingSeriesInventoryTool` from `/cli` take an injected provider/account-bound reader.
The command mounts `meetings scheduled` under an existing meetings group. It is a remote read,
marked `offline: false` and `mcp: false`; generic command routers must not grant inventory access.
A host explicitly mounts the raw `meeting_series_inventory` tool and owns any credential, request
and resource lifetime. No provider or default server tool is mounted by Core.

The CLI accepts `--since-time`, `--before-time`, `--limit`, `--max-read-bytes`, `--bytes` and
`--cursor`. MCP accepts `after`, `until`, `limit`, `max_read_bytes`, `bytes` and `cursor`. ISO
windows default to now and seven days ahead. Syntax, absolute dates, the 366-day window bound,
unknown fields and cursor structure are checked before the host callback; errors name the field.
The selected account/window binding is checked again by the SDK before provider I/O. The public
`validateMeetingSeriesInventoryCursor` helper checks bounded structure and strict UTF-8 without
returning or authorizing a provider continuation.

Success is a registered `meeting_series_inventory` item envelope with execution metadata.
Provider series IDs stay strings in `items[].meeting_id`; they are not stored meeting references.
Start hints and the absolute window become zoned ISO timestamps. The standard cursor `page`,
source fingerprint, requested limits and mandatory coverage remain. A zero-row page can still
have `page.has_more: true`. `meta.complete` reflects partial-source status and `meta.truncated`
reflects continuation; neither is a claim of complete calendar discovery or a verified next call.
No join or evidence URLs are added.

Replay `page.next_cursor` with the returned absolute `after` and `until`; reusing a relative default
clock with an old cursor can change the selection. The page can repeat IDs because reads are live.
A provider response naming different window bounds, contradictory continuation, invalid
schema or oversized item fails explicitly. Wire-format bytes are checked again after ISO mapping
and MCP text escaping. The adapter never silently drops candidates or advances another provider
page to satisfy an output budget. Lower `limit` or increase the relevant bounded byte grant.

The shared command is included in command lint and the unchanged generic personal-MCP catalogue
proof. Synthetic CLI/MCP tests exercise two invented providers, identical wire items, strict raw
arguments, frozen continuations, unknown coverage, cancellation, invalid provider dates and budgets.
Native providers must separately prove bounded HTTP and selected-credential behavior.

## Provider answer contracts

Prefer an existing shared entity for a command's answer. When a provider must retain its own public wire fields,
call `answerEntity(command, "provider_recording", schema)` from `@wirecat/cli-core/cli` with a Valibot object
schema. The shared command contract, help field reference and `--json` projection all use that schema.
The binding belongs to that command instance; it cannot replace a shared entity or alter another program.
Validate real synthetic command answers against the advertised contract, including preview and applied variants.

For a correlated batch whose `--json` fields belong to each nested answer, pass `{ project: payloadSchema }`
as the fourth `answerEntity` argument. The result contract still describes the complete correlated wrapper;
field validation uses the payload schema. The shared meeting batch command declares this itself.
