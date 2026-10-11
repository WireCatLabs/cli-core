# Provider integration

The SDK exposes separate capabilities rather than a mandatory provider base class. Existing
`MeetingSource` ingestion and `MeetingStore` persistence remain unchanged. Zoom supplies the first
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
| `MeetingSearchStore` | bounded hit pages with opaque continuation and coverage | seek pagination, read budgets and account/query-bound cursors |
| `MeetingSearchIndexStore` | explicit bounded maintenance receipt | scoped pending rows and transactional byte-bounded indexing batches |
| `MeetingTranscriptReceiptStore` | exact append outcomes | counts and writes in one transaction, including historical replay |
| `MeetingTranscriptionSource` | bounded recognition segments, provenance and one explicit append | ordinary media files, decoding and an already installed local model |

No capability requires the others. A read-only assistant can expose `get` without recordings or
writes. A recording service can implement a catalog and transfers without managing meetings.
The SDK contains no filesystem, database, vendor client, credentials or automatic provider setup.
cli-messaging implements the durable meeting store and its evidence/context/semantic services.

## Remote management

```ts
import { createMeetingManagement, type ManagedMeeting } from "@wirecat/cli-messaging/meetings"

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
never retries. Common errors extend cli-core `CliError` and keep its codes. HTTP status translation
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
} from "@wirecat/cli-messaging/meetings"

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

`indexSearch` maintains a bounded pending batch explicitly; read-only hit paging never drains queues.
Hit continuation bounds rows inside one meeting. Its coverage reports pending indexing and unknown
archive completeness. It is a live view, not a snapshot across modifications between calls. Exact
append receipts do not imply bounded legacy meeting-history hydration in a producer adapter.

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
