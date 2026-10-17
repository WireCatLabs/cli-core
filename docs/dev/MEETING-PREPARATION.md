# Meeting preparation SDK

`createMeetingPreparationService` from `@wirecat/cli-core/services` composes the next candidate of
one selected provider series with its stored history and related stored meetings. It is read-only: no login, index refresh,
model invocation, project/person association, accepted finding or task is created.

```ts
import { createUpcomingMeetingReader } from "@wirecat/cli-core/meetings"
import { createMeetingPreparationService } from "@wirecat/cli-core/services"

const scope = { provider: "example-calendar", account: "AliceExample" }
const upcoming = createUpcomingMeetingReader(scope, {
  read: async (meetingId) => ({
    meetingId, kind: "single", timezone: "UTC", complete: true, missing: [],
    occurrences: [{
      id: "invented-next", startAt: 1792051200000, endAt: 1792053000000,
      status: "scheduled", verified: true,
    }],
  }),
})
```

The host obtains its authorized numeric store account and constructs
`createMeetingPreparationService(scope, accountId, { meetings: store.meetings, upcoming })`.
Call `prepare(externalSeriesId, { after, until, historyAfter, signal? })` with absolute epoch
milliseconds. Upcoming selection uses `[after, until)`; stored history uses `[historyAfter, after)`.
The service verifies the stored account metadata matches the captured provider/account label before
the provider read. Labels themselves are not authentication; the host binds credentials and access.
The SDK never substitutes an occurrence ID or title for the exact provider series key.

The host owns resource lifetime and response framing. These are SDK domain objects, not CLI
envelopes. Hosts can mount `addMeetingPreparationCommand` and `meetingPreparationTool` from `./cli`
with an account-bound `MeetingPreparationReader`. CLI and MCP call the same `readMeetingPreparation`
validator and mapper, producing the registered `meeting_preparation` entity in an item envelope.
These adapters are opt-in; importing Core does not mount them in a provider application.
Automatic findings intake remains separate.

[Selected communications](MEETING-COMMUNICATIONS.md) documents the optional host-captured local
message/mail/document port, shared selection input, source coverage and output priorities.

## Context and limits

| Part | Included | Coverage limit |
|---|---|---|
| Upcoming | Selected-series proof from the shared upcoming reader | Calendar completeness is unknown; a useful candidate may remain unverified |
| History | Exact account/series, newest first with deterministic ties | Missing series, undated rows and additional stored rows are reported |
| Transcript | Existing bounded evidence packets with cue references and content fingerprints | Current revisions only, at most two transcript pages per occurrence; packet coverage retains continuation |
| Participants | Observed participant IDs/names and existing person IDs | No name matching, person merging or claim that past attendees will attend the upcoming call |
| Projects | Existing confirmed global project memberships | Proposed memberships are excluded; no alias-derived association |
| Facts | Accepted facts whose subject is this meeting, including decisions and promises | Proposed/reversed facts and facts about other subjects are excluded; evidence is not revalidated |
| Tasks | Existing tasks with this exact meeting source group and a source beneath its reference | Includes current task status; excludes other-account projects and unrelated project tasks |
| Related meetings | Other series joined through existing person links or confirmed global project memberships shared with included history | Same account and history window; dated live meetings only; no name, email or alias matching |
| Owner notes | Owner-written notes and annotations about included meetings, explicitly linked people or confirmed global projects | Optional port; current revisions only, no imported files, messages or mail; note text is distinct from accepted facts |
| Accepted knowledge | Global person/project facts through those explicit associations, with fact references and association flags | Optional port, accepted status only; no mail, messages or notes; source evidence is not revalidated |

Related history records its anchor meeting references and separate `sharedPerson`/`sharedProject`
flags. The SQLite `relatedHistory` port derives these links from current stored anchors in one read
snapshot; it excludes the selected series and deduplicates both association paths. Up to `meetings`
additional meetings are returned newest first, with ID ties descending and independent `hasMore`.
The service reads cited cues without refreshing the derived search index. If there are no included
exact-series anchors, related history remains unqueried. When it is queried, person-history and
project-wide coverage are replaced in `unqueried` by the narrower `person-nonmeeting-context` and `project-nonmeeting-context` gaps;
project-alias candidates retain their broad unqueried marker because selecting one project cannot discover every possible project. This covers related meeting transcripts, not
mail, messages or every source about a person. The optional notes section below adds a bounded subset of owner notes. The result is a factual context bundle for an agent, not an AI-generated summary.
Stored facts and task provenance do not establish that their underlying evidence still holds.

### Accepted person and project facts

`store.meetings.preparationKnowledge` adds an optional `knowledge` section after exact-series and
related evidence. Custom hosts without that method remain compatible; the section is absent and
existing nonmeeting coverage gaps remain visible. The method uses `MeetingPreparationKnowledgeRequest`
from `./meetings`: account/series, at most twenty included anchor IDs, history bounds, `limit`,
`maxReadBytes` and `signal`. It accepts the same validated bounds as `relatedHistory`.

The native adapter rechecks live same-account/series anchors within the history window, current
person links and confirmed global project memberships in one read snapshot. It selects accepted,
undeleted facts whose subject is an explicitly linked person, whose subject is a confirmed project,
or whose project is a confirmed project. Account-scoped subjects and projects are excluded even
when another association qualifies. A fact attached to a meeting is handled by meeting context,
not repeated here. Facts updated after the preparation start are excluded; older accepted
facts may predate the meeting history window. This is current accepted knowledge, not an historical
snapshot or proof of when the asserted event occurred.

The page returns at most `min(contextLimit, 20)` facts, newest update then ID descending, with
deduplication and independent lookahead. UTF-8 type/statement bytes, including lookahead, are checked
before hydration. Database scan/sort work remains unbounded by row limits. Each item includes `ref`,
`type`, `statement`, `subject`, `project`, `updatedAt`, `sharedPerson` and `sharedProject`. The fact
reference lets an agent retrieve the full record and evidence separately. No full evidence graph,
annotation body, model output or source message is read by this capability.

`knowledge` records included anchor references and the selection `accepted-global-person/project-facts`.
Its `coverage` holds `hasMore`, `outputLimited`, `factEvidence: not-revalidated` and `otherSources: not-queried`.
The shared field projector retains that object even when selecting only `knowledge.items.ref`.
Existing nonmeeting coverage gaps remain because this is not a complete search of notes and communications.
Its optional data is trimmed before related or exact-series evidence when the public mapper's
normalized output exceeds `bytes`. Public fields use snake_case and ISO update timestamps.

### Owner notes about people and projects

The optional `store.meetings.preparationNotes` port adds `notes` after meeting evidence and accepted
knowledge. It uses the same validated account, series, included anchor IDs and bounds as
`preparationKnowledge`. Hosts without the method remain compatible; an absent section does not mean
there are no matching notes. No store migration is required.

The native adapter reads owner-authored rows from the shared notes table, including annotations.
A live note qualifies through its primary meeting/person/project subject or a confirmed additional
`about` link to an included meeting, currently linked person or confirmed global project from the
included history. Its primary subject must itself be a live global person/project or a live meeting in the selected account.
Meeting-scoped notes additionally require a primary or confirmed additional association to an
included anchor; a shared person/project association alone never qualifies them. Notes whose primary
meeting belongs to another account are excluded even when an additional global project link matches. Chat subjects remain
excluded. Proposed links, bot-authored notes, deleted notes and
account-scoped or deleted projects are excluded. No name, email, title or alias matching takes place.
Current revisions updated at or before the preparation start qualify, including notes older than the
history window. This is a live read, not an historical snapshot.

Items carry `ref` (`note:<id>`), nullable `title`, `text`, `revision`, `updatedAt` and nullable `person`
and `project` references. Native pages also carry nullable `meeting`, a canonical reference to
one qualifying included anchor. Custom legacy hosts may omit this field. Each association reference
is the smallest matching stored ID of that type;
it proves one qualifying association, rather than listing all subjects or attendees. A note matching
both paths is returned once. Retrieve the referenced note separately for all its associations.

Up to `min(contextLimit, 20)` notes are returned, newest update then ID descending. A separate
lookahead determines `notes.coverage.hasMore`. UTF-8 title and body bytes, including lookahead,
are checked in one read snapshot before body hydration; row limits do not bound SQL scan/sort work.
`notes.anchors` records included history references, and `selection` is
`owner-written-meeting/person/project-notes` for the native adapter. Legacy hosts may omit the
page selection and meeting field; the assembler retains `owner-written-global-person/project-notes`
for those pages. A meeting association must name an included anchor and requires the extended
selection. Coverage contains `hasMore`, `outputLimited`,
`sourceEvidence: not-revalidated` and `otherSources: not-queried`. Public answers use snake_case
and ISO timestamps; selecting `notes.items.ref` retains the nested coverage object.

Notes are owner text, separate from accepted facts. Imported/file documents, messages, mail and
unlinked notes remain unqueried; the broad nonmeeting coverage gaps remain. The assembler validates
custom host pages, refuses duplicates and byte overflows, and propagates read/cancellation failures.
Notes use the remaining output budget after accepted facts and meeting evidence. Public normalization
trims notes first, then accepted knowledge, related meetings and exact history; truncation stays visible.

### Word evidence for a selected project

The optional `project` request names one existing project by name, key or explicit alias. Hosts
opt in with `projectDiscovery: { vocabulary, search }`, the same narrow ports used by
`readMeetingProjectDiscovery`. A requested project without those ports fails before the upcoming
provider read. Omitting `project` preserves the previous reads and answer shape.

Preparation searches the selected account across `[historyAfter, after)`, including other series
and unlinked meetings. It does not infer which project the upcoming call concerns. `projectEvidence`
contains up to four consecutive discovery pages, each with at most `min(contextLimit, 20)` hits.
Pages retain the exact matched canonical name, key or alias, canonical project, vocabulary
fingerprint, cue/meeting reference, excerpt, offset and source meeting title. Titles are provenance,
not a separate title-matching lane. All matches remain `unconfirmed-word-evidence`; they neither
confirm membership nor feed the accepted project/fact/note sections.

A page may be empty and still have continuation. Multiple names may cite the same passage; these
are repeated word matches, not independent corroboration, and each page retains the existing
`may-repeat-between-terms` coverage. Four pages can stop within one name lane. The vocabulary
fingerprint and frozen account/history selection bind every cursor; changes fail rather than
silently advancing. Name resolution permits at most 32 distinct names and refuses excess names.
There is no index refresh: pending indexing and unknown archive/index completeness remain visible.

Each page performs one vocabulary read and one word read, both capped by `maxReadBytes`. The
additional run therefore allows at most eight such bounded reads (at most eight times that byte
limit); row limits do not bound SQL scan/sort work. Errors and cancellation propagate.

Public `project_evidence.pages` reuse the registered project-evidence item schema.
`project_evidence.continuation`, when present, names `meetings projects evidence` with `project`,
absolute frozen `query`, `cursor`, `limit` and `max_read_bytes`. Continue with that command or its
`meeting_project_evidence` MCP tool instead of fetching the upcoming schedule again. A null cursor
means restart the first page: omit `--cursor` / `cursor` in that case. Continuation remains available
after an empty page. The standalone command uses its normal vocabulary-read budget.

Candidate pages are the first data removed under SDK, public normalization or escaped MCP output
limits, before notes, accepted knowledge or meeting evidence. Trimming rewinds continuation to the
last retained page (or the start); it never skips omitted hits. If even section metadata cannot fit,
the section is absent and overall `outputLimited` remains true. The broad unqueried marker remains:
this optional selection does not search all project vocabularies or nonmeeting communications.

Defaults: five exact-series history meetings and up to five related meetings, ten cues per occurrence, twenty entries per context category,
256 KiB stored text per read and 64 KiB for the serialized result. Hard limits are twenty meetings,
one hundred cues, one hundred context entries per category, 4 MiB stored text per read and 4 MiB
output. Output budgets start at 4096 bytes. `maxReadBytes` is a per-read budget, not an aggregate
run budget. Row limits bound hydration rather than database scan/sort work.

Custom preparation ports must implement `relatedHistory` in addition to the existing bounded
meeting reads, series history and context ports. `store.meetings` implements all of them without
a store migration. Its metadata probe includes UTF-8 titles/IDs in lookahead rows before hydration;
row limits bound returned data, not SQL scan or sort work.

`preparationContext` checks account ownership, series membership and the expected meeting revision
in one read snapshot. UTF-8 text sizes across all four categories, including their lookahead rows,
are checked before any values are hydrated. Returned fields exclude descriptions, emails, provider
metadata and graph payloads. All category pages retain `hasMore`.

Preparation combines multiple live reads, rather than an immutable whole-brief snapshot. A meeting
that becomes unavailable or whose series/revision changes is skipped with its reference recorded.
Transcript packets retain their own availability and revision coverage. Provider, validation and
byte-limit failures propagate; they never become a false empty success. Cancellation refuses the
result. Recheck sources and write preconditions before accepting findings from a brief.

The overall output budget gives exact-series entries priority, then adds related evidence with
the remaining bytes. Omitted related entries set both `related.outputLimited` and the overall
`outputLimited`; extra related matches retain their independent `hasMore`. Metadata that
cannot fit is refused with an instruction to increase the budget. Archive completeness remains
unknown even when every selected stored row fits. No source is read from another account merely
because a participant, project alias or meeting title looks similar.

## Shared CLI and MCP adapters

`addMeetingPreparationCommand(program, { read, output, signal, now? })` mounts `meetings prepare
<series-id>` under an existing meetings group. Options include `--project` for the optional selected-project evidence and `--since-time`, `--before-time`, `--history-since-time`,
`--meetings`, `--cues`, `--context-limit`, `--max-read-bytes` and `--bytes`. Time options take valid ISO
instants with an explicit zone. The default window starts at the injected clock, ends seven days
later and reads thirty days of history before its start. The answer retains absolute normalized
windows for replay. Limits use the SDK's shared bounds and defaults.

`callMeetingPreparationTool(read, args, signal?, failure?, now?)` implements `meeting_prepare`.
Arguments use `series_id`, optional `project`, `after`, `until`, `history_after`, `meetings`, `cues`, `context_limit`,
`max_read_bytes` and `bytes`. The handler refuses unknown fields by name before calling `read`;
caller-controlled accounts, providers and credentials are never arguments. JSON Schema advertises
integer ranges and disallows additional properties. All failures retain the shared error envelope.

The transport declares remote/local reads and never mounts automatically. The host owns credentials,
resource lifetime, final run metadata, error context and any consent policy for remote reads.
Close owned connections before rendering the returned answer.

The public item uses snake_case keys, string IDs, ISO timestamps and `ref` for cue/meeting citations.
Cue `offset_ms` is relative to its meeting. Its strict entity schema includes every coverage field;
no source packet is replaced with an unchecked record. Evidence `content_bytes` counts its public
cue array. The item's `limits.bytes` bounds its JSON representation, excluding the outer envelope;
normalization removes communication excerpts first, then project-evidence pages, notes, accepted knowledge and trailing related entries before exact-series entries to keep that bound,
reporting `output_limited`. Related public fields are `anchors`, `items`, `has_more`, `output_limited`
and `selection`; each item contains `ref`, `meeting`, `evidence`, `shared_person` and `shared_project`.
MCP reapplies the same item budget after making hidden/control characters visible. It recalculates
cue `content_bytes` for that escaped representation, trims notes before accepted knowledge and
meeting evidence, and sets `meta.truncated` when it omits data. CLI JSON retains its original text.
Unfit metadata is refused. Skipped unavailable meetings set `meta.complete=false` with source issues;
output byte truncation sets `meta.truncated`. Unknown archive coverage remains a domain coverage
fact rather than a claim that failed sources succeeded.
