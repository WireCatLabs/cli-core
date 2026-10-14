# Meeting preparation SDK

`createMeetingPreparationService` from `@wirecat/cli-core/services` composes the next candidate of
one selected provider series with its stored history. It is read-only: no login, index refresh,
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
envelopes. There is no preparation command, MCP tool or automatic findings intake in this slice.

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

Person-history context, project-wide context and project-alias candidates are explicitly listed as
unqueried. The result is a factual context bundle for an agent, not an AI-generated summary.
Stored facts and task provenance do not establish that their underlying evidence still holds.

Defaults: five history meetings, ten cues per occurrence, twenty entries per context category,
256 KiB stored text per read and 64 KiB for the serialized result. Hard limits are twenty meetings,
one hundred cues, one hundred context entries per category, 4 MiB stored text per read and 4 MiB
output. Output budgets start at 4096 bytes. `maxReadBytes` is a per-read budget, not an aggregate
run budget. Row limits bound hydration rather than database scan/sort work.

`preparationContext` checks account ownership, series membership and the expected meeting revision
in one read snapshot. UTF-8 text sizes across all four categories, including their lookahead rows,
are checked before any values are hydrated. Returned fields exclude descriptions, emails, provider
metadata and graph payloads. All category pages retain `hasMore`.

Preparation combines multiple live reads, rather than an immutable whole-brief snapshot. A meeting
that becomes unavailable or whose series/revision changes is skipped with its reference recorded.
Transcript packets retain their own availability and revision coverage. Provider, validation and
byte-limit failures propagate; they never become a false empty success. Cancellation refuses the
result. Recheck sources and write preconditions before accepting findings from a brief.

The overall output budget stops further history entries and reports `outputLimited`. Metadata that
cannot fit is refused with an instruction to increase the budget. Archive completeness remains
unknown even when every selected stored row fits. No source is read from another account merely
because a participant, project alias or meeting title looks similar.
